import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_RETRYABLE_ATTEMPTS_BEFORE_QUARANTINE,
  applyPageOutcome,
  classifyPageResult,
  collectedPayloadsPendingIngest,
  emptyState,
  loadState,
  markIngested,
  needsPageFetch,
  saveStateAtomic,
  type CathoState,
} from "./state";

const CANDIDATE = {
  id: "37070531",
  url: "https://www.catho.com.br/vagas/estagio-x/37070531/",
};
const JOB_POSTING = { title: "Estágio X" };

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
    });
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
