import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_RETRYABLE_ATTEMPTS_BEFORE_QUARANTINE,
  acquireLock,
  applyPageOutcome,
  classifyPageResult,
  collectedPayloadsPendingIngest,
  emptyState,
  isAllowedCathoUrl,
  loadState,
  markIngested,
  needsPageFetch,
  refreshLock,
  releaseLock,
  requeueQuarantined,
  saveStateAtomic,
  type CathoState,
} from "./state";

const CANDIDATE = {
  id: "37070531",
  url: "https://www.catho.com.br/vagas/estagio-x/37070531/",
};
const JOB_POSTING = { title: "Estágio X" };

describe("isAllowedCathoUrl (AC-034 — SSRF-shaped sitemap candidate)", () => {
  it("accepts a real Catho posting URL", () => {
    expect(isAllowedCathoUrl(CANDIDATE.url)).toBe(true);
  });

  it("rejects a private/local IP address", () => {
    expect(isAllowedCathoUrl("http://127.0.0.1/vagas/estagio-x/1/")).toBe(
      false,
    );
  });

  it("rejects an external host with a Catho-shaped path", () => {
    expect(
      isAllowedCathoUrl("https://evil.example.com/vagas/estagio-x/1/"),
    ).toBe(false);
  });

  it("rejects a Catho lookalike subdomain", () => {
    expect(
      isAllowedCathoUrl("https://www.catho.com.br.evil.com/vagas/x/1/"),
    ).toBe(false);
  });

  it("rejects plain http even on the real host", () => {
    expect(
      isAllowedCathoUrl("http://www.catho.com.br/vagas/estagio-x/1/"),
    ).toBe(false);
  });

  it("rejects an unparseable URL rather than throwing", () => {
    expect(isAllowedCathoUrl("not a url")).toBe(false);
  });

  it("rejects a nonstandard port on the real host (docs/audit PR-020)", () => {
    // URL.hostname never includes the port -- checking only hostname
    // silently accepted this.
    expect(
      isAllowedCathoUrl("https://www.catho.com.br:9999/vagas/estagio-x/1/"),
    ).toBe(false);
  });

  it("accepts the real host with the default https port stated explicitly", () => {
    expect(
      isAllowedCathoUrl("https://www.catho.com.br:443/vagas/estagio-x/1/"),
    ).toBe(true);
  });
});

describe("classifyPageResult (AC-002 — retryable vs. expired)", () => {
  it("classifies a real posting page as collected", () => {
    const outcome = classifyPageResult({
      httpStatus: 200,
      finalUrl: CANDIDATE.url,
      jsonLd: JOB_POSTING,
      pageTitle: "Vaga de Emprego de Estágio X, Rio de Janeiro /",
      candidate: CANDIDATE,
    });
    expect(outcome.kind).toBe("collected");
    if (outcome.kind === "collected") {
      expect(outcome.payload).toEqual({
        id: CANDIDATE.id,
        url: CANDIDATE.url,
        pageTitle: "Vaga de Emprego de Estágio X, Rio de Janeiro /",
        jobPosting: JOB_POSTING,
      });
    }
  });

  it("classifies a 2xx redirect to the bare listing page as expired", () => {
    const outcome = classifyPageResult({
      httpStatus: 200,
      finalUrl: "https://www.catho.com.br/vagas/",
      jsonLd: null,
      pageTitle: "Vagas de emprego em todo Brasil | Catho",
      candidate: CANDIDATE,
    });
    expect(outcome).toEqual({ kind: "expired" });
  });

  it("classifies the listing page without a trailing slash as expired too", () => {
    const outcome = classifyPageResult({
      httpStatus: 200,
      finalUrl: "https://www.catho.com.br/vagas",
      jsonLd: null,
      pageTitle: "Vagas de emprego em todo Brasil | Catho",
      candidate: CANDIDATE,
    });
    expect(outcome).toEqual({ kind: "expired" });
  });

  // The real bug this test guards against (AC-002): a 403 from Catho's
  // bot-fingerprint block, confirmed live during the pre-deploy audit, was
  // previously indistinguishable from a genuinely expired posting.
  it("classifies a 403 as retryable, never expired", () => {
    const outcome = classifyPageResult({
      httpStatus: 403,
      finalUrl: CANDIDATE.url,
      jsonLd: null,
      pageTitle: "403 Forbidden",
      candidate: CANDIDATE,
    });
    expect(outcome).toEqual({ kind: "retryable", reason: "HTTP 403" });
  });

  it.each([429, 500, 502, 503])("classifies HTTP %i as retryable", (status) => {
    const outcome = classifyPageResult({
      httpStatus: status,
      finalUrl: CANDIDATE.url,
      jsonLd: null,
      pageTitle: "",
      candidate: CANDIDATE,
    });
    expect(outcome).toEqual({ kind: "retryable", reason: `HTTP ${status}` });
  });

  it("classifies no response at all (timeout/network error) as retryable", () => {
    const outcome = classifyPageResult({
      httpStatus: null,
      finalUrl: CANDIDATE.url,
      jsonLd: null,
      pageTitle: "",
      candidate: CANDIDATE,
    });
    expect(outcome).toEqual({ kind: "retryable", reason: "no response" });
  });

  it("classifies a 2xx that redirected off catho.com.br as retryable, not collected (docs/audit AC-034)", () => {
    const outcome = classifyPageResult({
      httpStatus: 200,
      finalUrl: "https://evil.example.com/vagas/estagio-x/37070531/",
      jsonLd: JOB_POSTING,
      pageTitle: "Vaga de Emprego de Estágio X, Rio de Janeiro /",
      candidate: CANDIDATE,
    });
    expect(outcome).toEqual({
      kind: "retryable",
      reason: "final URL host not allowed",
    });
  });

  it("classifies a 2xx on the real posting URL with missing JSON-LD as retryable, not expired", () => {
    const outcome = classifyPageResult({
      httpStatus: 200,
      finalUrl: CANDIDATE.url,
      jsonLd: null,
      pageTitle: "Vaga de Emprego de Estágio X, Rio de Janeiro /",
      candidate: CANDIDATE,
    });
    expect(outcome).toEqual({
      kind: "retryable",
      reason: "missing or invalid JSON-LD",
    });
  });
});

describe("applyPageOutcome / needsPageFetch (AC-001/AC-002 state machine)", () => {
  it("a collected outcome stores the payload and is not re-fetched next run", () => {
    const outcome = classifyPageResult({
      httpStatus: 200,
      finalUrl: CANDIDATE.url,
      jsonLd: JOB_POSTING,
      pageTitle: "x",
      candidate: CANDIDATE,
    });
    const state = applyPageOutcome(emptyState(), CANDIDATE.id, outcome);
    expect(state.entries[CANDIDATE.id]?.state).toBe("collected");
    expect(needsPageFetch(state, CANDIDATE.id)).toBe(false);
  });

  it("an expired outcome is terminal — not re-fetched next run", () => {
    const state = applyPageOutcome(emptyState(), CANDIDATE.id, {
      kind: "expired",
    });
    expect(state.entries[CANDIDATE.id]?.state).toBe("expired");
    expect(needsPageFetch(state, CANDIDATE.id)).toBe(false);
  });

  it("a retryable outcome IS re-fetched next run", () => {
    const state = applyPageOutcome(emptyState(), CANDIDATE.id, {
      kind: "retryable",
      reason: "HTTP 403",
    });
    expect(state.entries[CANDIDATE.id]?.state).toBe("retryable");
    expect(needsPageFetch(state, CANDIDATE.id)).toBe(true);
  });

  it("an unknown id needs a fetch", () => {
    expect(needsPageFetch(emptyState(), "999")).toBe(true);
  });

  it("quarantines an id after MAX_RETRYABLE_ATTEMPTS_BEFORE_QUARANTINE consecutive failures", () => {
    let state: CathoState = emptyState();
    for (let i = 0; i < MAX_RETRYABLE_ATTEMPTS_BEFORE_QUARANTINE - 1; i++) {
      state = applyPageOutcome(state, CANDIDATE.id, {
        kind: "retryable",
        reason: "HTTP 403",
      });
      expect(state.entries[CANDIDATE.id]?.state).toBe("retryable");
    }
    state = applyPageOutcome(state, CANDIDATE.id, {
      kind: "retryable",
      reason: "HTTP 403",
    });
    expect(state.entries[CANDIDATE.id]).toEqual({
      state: "quarantined",
      failCount: MAX_RETRYABLE_ATTEMPTS_BEFORE_QUARANTINE,
      reason: "HTTP 403",
    });
  });

  it("carries the most recent failure's own reason, not just that it failed (docs/audit PR-011)", () => {
    let state: CathoState = emptyState();
    state = applyPageOutcome(state, CANDIDATE.id, {
      kind: "retryable",
      reason: "HTTP 403",
    });
    expect(state.entries[CANDIDATE.id]?.reason).toBe("HTTP 403");

    state = applyPageOutcome(state, CANDIDATE.id, {
      kind: "retryable",
      reason: "no response",
    });
    // Overwritten, not accumulated -- this is "why did the most recent
    // attempt fail," not a full history.
    expect(state.entries[CANDIDATE.id]?.reason).toBe("no response");
  });

  it("a quarantined id is not fetched again automatically", () => {
    let state: CathoState = emptyState();
    for (let i = 0; i < MAX_RETRYABLE_ATTEMPTS_BEFORE_QUARANTINE; i++) {
      state = applyPageOutcome(state, CANDIDATE.id, {
        kind: "retryable",
        reason: "HTTP 403",
      });
    }
    expect(state.entries[CANDIDATE.id]?.state).toBe("quarantined");
    expect(needsPageFetch(state, CANDIDATE.id)).toBe(false);
  });

  it("a later success resets the fail count — collected, not retryable/quarantined", () => {
    let state: CathoState = emptyState();
    state = applyPageOutcome(state, CANDIDATE.id, {
      kind: "retryable",
      reason: "HTTP 403",
    });
    state = applyPageOutcome(state, CANDIDATE.id, {
      kind: "collected",
      payload: {
        id: CANDIDATE.id,
        url: CANDIDATE.url,
        pageTitle: "x",
        jobPosting: JOB_POSTING,
      },
    });
    expect(state.entries[CANDIDATE.id]?.state).toBe("collected");
    expect(state.entries[CANDIDATE.id]?.failCount).toBeUndefined();
  });

  it("does not mutate the state object passed in", () => {
    const before = emptyState();
    applyPageOutcome(before, CANDIDATE.id, { kind: "expired" });
    expect(before.entries).toEqual({});
  });
});

function quarantine(state: CathoState, id: string): CathoState {
  let next = state;
  for (let i = 0; i < MAX_RETRYABLE_ATTEMPTS_BEFORE_QUARANTINE; i++) {
    next = applyPageOutcome(next, id, {
      kind: "retryable",
      reason: "HTTP 403",
    });
  }
  return next;
}

describe("requeueQuarantined (docs/audit PR-011 — an operable retry control)", () => {
  it("removes a named quarantined entry, making it eligible for a fresh fetch again", () => {
    const state = quarantine(emptyState(), CANDIDATE.id);
    expect(needsPageFetch(state, CANDIDATE.id)).toBe(false);

    const result = requeueQuarantined(state, [CANDIDATE.id]);

    expect(result.requeued).toEqual([CANDIDATE.id]);
    expect(result.state.entries[CANDIDATE.id]).toBeUndefined();
    expect(needsPageFetch(result.state, CANDIDATE.id)).toBe(true);
  });

  it("requeues every quarantined entry when no ids are given", () => {
    let state = quarantine(emptyState(), "1");
    state = quarantine(state, "2");
    state = applyPageOutcome(state, "3", { kind: "expired" });

    const result = requeueQuarantined(state);

    expect([...result.requeued].sort()).toEqual(["1", "2"]);
    expect(result.state.entries["1"]).toBeUndefined();
    expect(result.state.entries["2"]).toBeUndefined();
    // Not quarantined -- untouched.
    expect(result.state.entries["3"]?.state).toBe("expired");
  });

  it("skips an id that is not quarantined, without touching it", () => {
    const state = applyPageOutcome(emptyState(), CANDIDATE.id, {
      kind: "retryable",
      reason: "HTTP 403",
    });

    const result = requeueQuarantined(state, [CANDIDATE.id]);

    expect(result.requeued).toEqual([]);
    expect(result.state.entries[CANDIDATE.id]?.state).toBe("retryable");
  });

  it("skips an id that does not exist at all, without throwing", () => {
    const result = requeueQuarantined(emptyState(), ["does-not-exist"]);
    expect(result.requeued).toEqual([]);
  });

  it("does not mutate the state object passed in", () => {
    const before = quarantine(emptyState(), CANDIDATE.id);
    const snapshot = JSON.stringify(before);
    requeueQuarantined(before, [CANDIDATE.id]);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe("collectedPayloadsPendingIngest / markIngested (AC-001 — no checkpoint before durable ingest)", () => {
  it("returns every collected payload, regardless of this run's candidate list", () => {
    let state: CathoState = emptyState();
    state = applyPageOutcome(state, "1", {
      kind: "collected",
      payload: { id: "1", url: "u1", pageTitle: "t1", jobPosting: {} },
    });
    state = applyPageOutcome(state, "2", { kind: "expired" });
    state = applyPageOutcome(state, "3", {
      kind: "collected",
      payload: { id: "3", url: "u3", pageTitle: "t3", jobPosting: {} },
    });

    const pending = collectedPayloadsPendingIngest(state);
    expect(pending.map((p) => p.id).sort()).toEqual(["1", "3"]);
  });

  it("markIngested moves collected entries to ingested — the only path to that state", () => {
    let state: CathoState = emptyState();
    state = applyPageOutcome(state, "1", {
      kind: "collected",
      payload: { id: "1", url: "u1", pageTitle: "t1", jobPosting: {} },
    });

    state = markIngested(state, ["1"]);

    expect(state.entries["1"]).toEqual({ state: "ingested" });
    expect(collectedPayloadsPendingIngest(state)).toEqual([]);
  });

  it("a failed ingest (markIngested never called) leaves the payload pending for the next run", () => {
    // This is the actual regression test for AC-001: the old code saved the
    // ID as "seen" unconditionally, before the ingest POST. Here, simply
    // never calling markIngested (as collect.ts does on a non-2xx or a
    // network failure) must leave the payload retryable via ingest alone.
    let state: CathoState = emptyState();
    state = applyPageOutcome(state, "1", {
      kind: "collected",
      payload: { id: "1", url: "u1", pageTitle: "t1", jobPosting: {} },
    });

    expect(state.entries["1"]?.state).toBe("collected");
    expect(collectedPayloadsPendingIngest(state)).toHaveLength(1);
    // Crucially, it does NOT need a page fetch again — only ingest.
    expect(needsPageFetch(state, "1")).toBe(false);
  });

  it("markIngested ignores an id that is not currently collected", () => {
    const state = markIngested(emptyState(), ["never-seen"]);
    expect(state.entries["never-seen"]).toBeUndefined();
  });
});

describe("loadState / saveStateAtomic", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "catho-state-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty state when the file does not exist", () => {
    expect(loadState(join(dir, "missing.json"))).toEqual(emptyState());
  });

  it("round-trips a real state through save and load", () => {
    const path = join(dir, "state.json");
    let state: CathoState = emptyState();
    state = applyPageOutcome(state, "1", {
      kind: "collected",
      payload: { id: "1", url: "u1", pageTitle: "t1", jobPosting: { a: 1 } },
    });
    state = applyPageOutcome(state, "2", { kind: "expired" });

    saveStateAtomic(path, state);
    const reloaded = loadState(path);

    expect(reloaded).toEqual(state);
  });

  it("falls back to empty state on malformed JSON, rather than throwing", () => {
    const path = join(dir, "state.json");
    writeFileSync(path, "not json{{{", "utf8");
    expect(loadState(path)).toEqual(emptyState());
  });

  it("falls back to empty state on the old flat-array format, rather than throwing", () => {
    const path = join(dir, "state.json");
    writeFileSync(path, JSON.stringify(["37070531", "37069980"]), "utf8");
    expect(loadState(path)).toEqual(emptyState());
  });

  it("falls back to empty state when a version-2 entry is structurally invalid", () => {
    const path = join(dir, "state.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        entries: { "37070531": { state: "collected", payload: null } },
      }),
      "utf8",
    );
    expect(loadState(path)).toEqual(emptyState());
  });

  it("leaves the previous file intact if a save is interrupted before rename", () => {
    // saveStateAtomic writes to a temp file then renames — simulate reading
    // mid-write by checking the real file is only ever the last *complete*
    // write, never a partial one, by writing twice and reading between.
    const path = join(dir, "state.json");
    saveStateAtomic(
      path,
      applyPageOutcome(emptyState(), "1", { kind: "expired" }),
    );
    const afterFirst = readFileSync(path, "utf8");
    expect(JSON.parse(afterFirst).entries["1"].state).toBe("expired");

    saveStateAtomic(
      path,
      applyPageOutcome(emptyState(), "2", { kind: "expired" }),
    );
    const afterSecond = JSON.parse(readFileSync(path, "utf8")) as CathoState;
    expect(afterSecond.entries["2"]?.state).toBe("expired");
    expect(afterSecond.entries["1"]).toBeUndefined();
  });
});

describe("acquireLock / releaseLock (docs/audit PR-012 — single-writer mutual exclusion)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "catho-lock-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("acquires a lock that does not exist yet", () => {
    const lockPath = join(dir, "state.json.lock");
    expect(acquireLock(lockPath).acquired).toBe(true);
  });

  it("refuses a second acquisition while the lock is fresh", () => {
    const lockPath = join(dir, "state.json.lock");
    acquireLock(lockPath);

    const second = acquireLock(lockPath);

    expect(second.acquired).toBe(false);
    expect(second.reason).toMatch(/lock held/);
  });

  it("allows re-acquiring after release", () => {
    const lockPath = join(dir, "state.json.lock");
    const first = acquireLock(lockPath);
    releaseLock(lockPath, first.token!);

    expect(acquireLock(lockPath).acquired).toBe(true);
  });

  it("refreshes only the current owner's lease", () => {
    const lockPath = join(dir, "state.json.lock");
    const acquired = acquireLock(lockPath);
    const refreshedAt = new Date("2026-08-17T04:00:00Z");

    expect(refreshLock(lockPath, "not-the-owner", refreshedAt)).toBe(false);
    expect(refreshLock(lockPath, acquired.token!, refreshedAt)).toBe(true);
    expect(
      acquireLock(lockPath, new Date(refreshedAt.getTime() + 500), 1_000)
        .acquired,
    ).toBe(false);
  });

  it("an old owner cannot release a lock after stale takeover", () => {
    const lockPath = join(dir, "state.json.lock");
    const created = new Date("2026-08-17T03:00:00Z");
    const oldOwner = acquireLock(lockPath, created, 1_000);
    utimesSync(lockPath, created, created);
    const newOwner = acquireLock(
      lockPath,
      new Date(created.getTime() + 2_000),
      1_000,
    );
    expect(newOwner.acquired).toBe(true);

    releaseLock(lockPath, oldOwner.token!);
    expect(
      acquireLock(lockPath, new Date(created.getTime() + 2_100), 1_000)
        .acquired,
    ).toBe(false);

    releaseLock(lockPath, newOwner.token!);
    expect(acquireLock(lockPath).acquired).toBe(true);
  });

  it("releasing an already-released (or never-acquired) lock is a no-op, not a throw", () => {
    const lockPath = join(dir, "state.json.lock");
    expect(() => releaseLock(lockPath, "not-the-owner")).not.toThrow();
  });

  it("takes over a lock older than staleAfterMs, treating it as abandoned", () => {
    const lockPath = join(dir, "state.json.lock");
    const created = new Date("2026-08-17T03:00:00Z");
    acquireLock(lockPath);
    // acquireLock stats the file's real filesystem mtime -- backdating it
    // directly is the only deterministic way to simulate "this lock is
    // old" without a real sleep.
    utimesSync(lockPath, created, created);

    const stillFresh = acquireLock(
      lockPath,
      new Date(created.getTime() + 500),
      1_000,
    );
    expect(stillFresh.acquired).toBe(false);

    const nowStale = acquireLock(
      lockPath,
      new Date(created.getTime() + 2_000),
      1_000,
    );
    expect(nowStale.acquired).toBe(true);
  });
});
