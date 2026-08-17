/**
 * Checkpoint state for the Catho collector — the pure, testable core that
 * `collect.ts` drives. Exists to fix two findings from the repository audit
 * (`docs/audit/AUDIT_REPORT.md` AC-001, AC-002; plan in
 * `docs/audit/REMEDIATION_PLAN.md` §4):
 *
 * - **AC-001**: the previous version saved an ID as "seen" before the
 *   ingest POST to argos-career's API even attempted, let alone succeeded.
 *   A network failure, a 409 (RunLock busy), a timeout, or the process
 *   being killed between collection and ingest meant that batch was gone
 *   for good — collected for nothing, never retried, never entering the
 *   database. This module makes "ingested" a state only `markIngested`
 *   (called after a confirmed 2xx from the API) can reach.
 * - **AC-002**: the previous version treated *any* non-2xx response, any
 *   missing response, and any redirect away from the posting's own path as
 *   the same thing — "expired," permanently resolved, never revisited. A
 *   429, a 5xx, a timeout, or (the real case found auditing this collector
 *   live) a 403 from Catho's bot detection got recorded exactly like a
 *   posting that genuinely closed. `classifyPageResult` only returns
 *   `"expired"` for the one confirmed pattern — a 2xx response whose final
 *   URL lands on the bare `/vagas` listing — everything else is
 *   `"retryable"`, bounded by a fail-count before quarantine rather than
 *   silently retried forever or silently dropped.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

/**
 * The only host this collector is ever allowed to navigate a real browser
 * to (docs/audit AC-034). `discoverCandidates` reads `<loc>` entries out of
 * Catho's own sitemap XML — an external, unauthenticated source this
 * project does not control — and nothing before this point verified they
 * actually pointed at Catho. A compromised or malformed sitemap entry like
 * `http://127.0.0.1/vagas/estagio/123` matched the path-only regex
 * `toCandidate` used to apply and would have been handed straight to
 * `page.goto`, an SSRF-shaped risk from the browser's network position
 * (inside the container/host running this collector).
 */
const ALLOWED_CATHO_HOST = "www.catho.com.br";

/**
 * Strict allowlist: exactly `https://www.catho.com.br`, nothing else — not
 * a subdomain, not `http:`, not a different TLD, not a nonstandard port
 * (docs/audit PR-020: `URL.hostname` never includes the port, so checking
 * only `hostname` silently accepted `https://www.catho.com.br:9999/...` —
 * this docstring already promised "exactly" the origin and the code did
 * not deliver on it). `parsed.port` is `""` for the scheme's default port
 * (443 for `https:`), which is the only value accepted here.
 *
 * Used on every URL this collector's browser or `fetch` could reach before
 * that request is made — sitemap child URLs (`docs/audit PR-020`; a
 * compromised or malformed `<loc>` entry in the trusted sitemap index was
 * previously filtered only by a path-suffix regex, no host check at all),
 * every sitemap-derived candidate before it is ever navigated to, and
 * again on the final URL after navigation, since a same-domain page could
 * still carry an external redirect the sitemap URL alone would not
 * reveal.
 */
export function isAllowedCathoUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname.toLowerCase() === ALLOWED_CATHO_HOST &&
      parsed.port === ""
    );
  } catch {
    return false;
  }
}

export type CathoEntryState =
  "collected" | "ingested" | "expired" | "retryable" | "quarantined";

export interface CathoPayload {
  readonly id: string;
  readonly url: string;
  readonly pageTitle: string;
  readonly jobPosting: unknown;
}

export interface CathoStateEntry {
  readonly state: CathoEntryState;
  /** Present only while `state === "collected"` — the already-fetched
   * payload, kept durably so a failed ingest never means reopening the
   * page (REMEDIATION_PLAN.md §4, AC-001: "manter payloads coletados em
   * uma fila local durável"). */
  readonly payload?: CathoPayload;
  /** Consecutive retryable-failure count, present only on `"retryable"`/
   * `"quarantined"` entries. */
  readonly failCount?: number;
  /** The most recent `PageOutcome`'s own `reason` for a `"retryable"`/
   * `"quarantined"` entry (docs/audit PR-011) — previously computed by
   * `classifyPageResult` and then discarded the moment `applyPageOutcome`
   * ran, so a quarantined ID carried no trace of *why*: a persistent 403
   * looked identical to a persistent timeout or five different transient
   * causes in a row. Overwritten on every retry, not accumulated — this is
   * "why did the most recent attempt fail," not a full history. */
  readonly reason?: string;
}

export interface CathoState {
  readonly version: 2;
  readonly entries: Readonly<Record<string, CathoStateEntry>>;
}

/** After this many consecutive retryable failures, an ID stops being
 * retried automatically every run (REMEDIATION_PLAN.md §4, AC-002:
 * "retryable por um número limitado de ciclos antes de uma quarentena") —
 * but stays in the state file, visible and distinguishable from a real
 * success or a real expiration, not silently dropped. */
export const MAX_RETRYABLE_ATTEMPTS_BEFORE_QUARANTINE = 5;

export function emptyState(): CathoState {
  return { version: 2, entries: {} };
}

function isStateEntry(value: unknown): value is CathoStateEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  if (entry.state === "ingested" || entry.state === "expired") return true;
  if (entry.state === "retryable" || entry.state === "quarantined") {
    return (
      Number.isSafeInteger(entry.failCount) &&
      (entry.failCount as number) >= 1 &&
      typeof entry.reason === "string"
    );
  }
  if (entry.state !== "collected") return false;
  const payload = entry.payload;
  return (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    typeof (payload as Record<string, unknown>).id === "string" &&
    typeof (payload as Record<string, unknown>).url === "string" &&
    typeof (payload as Record<string, unknown>).pageTitle === "string" &&
    Object.hasOwn(payload, "jobPosting")
  );
}

/** Malformed, missing, or old-format (the previous flat `string[]` shape)
 * state files all fall back to empty rather than throwing — a corrupt
 * checkpoint must degrade to "start the backlog over," never crash the
 * collector (principle 1, extended to this external process). */
export function loadState(path: string): CathoState {
  if (!existsSync(path)) return emptyState();
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return emptyState();
    }
    if ((raw as { version?: unknown }).version !== 2) return emptyState();
    const entries = (raw as { entries?: unknown }).entries;
    if (
      entries === null ||
      typeof entries !== "object" ||
      Array.isArray(entries)
    ) {
      return emptyState();
    }
    if (!Object.values(entries).every(isStateEntry)) return emptyState();
    return { version: 2, entries: entries as Record<string, CathoStateEntry> };
  } catch {
    return emptyState();
  }
}

/**
 * Atomic write: serialize to a temp file in the same directory, then
 * rename over the real path. A crash mid-write leaves the previous,
 * complete state file in place — never a truncated or half-written one
 * (REMEDIATION_PLAN.md §4, AC-001: "gravação do state atômica e
 * recuperável após interrupção"). `rename` within one directory is atomic
 * on the POSIX filesystems this runs on (the Docker volume mount).
 */
export function saveStateAtomic(path: string, state: CathoState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(state), "utf8");
  renameSync(tmpPath, path);
}

/** After this long, an existing lock file is treated as abandoned rather
 * than held by a live process (docs/audit PR-012) — generous relative to
 * `MAX_PAGES_PER_RUN`'s default (300) at the default request interval
 * (1.5s), which bounds a normal run to well under this. */
export const DEFAULT_LOCK_STALE_AFTER_MS = 30 * 60 * 1000;

export interface LockResult {
  readonly acquired: boolean;
  /** Unforgeable ownership token required to refresh/release this lease. */
  readonly token?: string;
  /** Present only when `acquired` is `false` — why, for the caller's own
   * log line. */
  readonly reason?: string;
}

/**
 * Single-writer mutual exclusion for the state file (docs/audit PR-012):
 * `saveStateAtomic`'s rename is atomic against a torn write, but says
 * nothing about two *processes* — a manual run overlapping the scheduled
 * timer, say — each loading their own snapshot and each writing their own
 * view back, silently discarding whatever the other accumulated in
 * between (last-writer-wins). `wx` (write, fail if exists) makes
 * acquisition itself atomic at the filesystem level: two processes racing
 * to create the same lock file can never both succeed.
 *
 * A lock file that still exists is not automatically "someone else is
 * running" — a process that crashed mid-run (the exact PR-012 scenario
 * this collector otherwise has to survive) would leave one behind
 * forever with no other change here. `staleAfterMs` bounds how long a
 * lock is trusted before a new run takes it over anyway; there is no PID
 * liveness check (`kill -0`) because this collector's own doc comment
 * already states it runs as an ephemeral, possibly-containerized
 * process — a PID recorded by one container means nothing to a process
 * checking from a different one.
 */
export function acquireLock(
  lockPath: string,
  now: Date = new Date(),
  staleAfterMs: number = DEFAULT_LOCK_STALE_AFTER_MS,
): LockResult {
  mkdirSync(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const contents = JSON.stringify({
    token,
    pid: process.pid,
    startedAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
  });
  try {
    writeFileSync(lockPath, contents, { encoding: "utf8", flag: "wx" });
    return { acquired: true, token };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
  }

  let ageMs: number;
  try {
    ageMs = now.getTime() - statSync(lockPath).mtimeMs;
  } catch {
    // Removed between the failed create above and this stat -- treat as
    // free and let the caller's own next attempt (or this one, in
    // practice) succeed rather than reporting a lock that no longer
    // exists.
    return { acquired: false, reason: "lock state changed concurrently" };
  }
  if (ageMs <= staleAfterMs) {
    return {
      acquired: false,
      reason: `lock held (${Math.round(ageMs / 1000)}s old)`,
    };
  }

  // Serialize stale takeover itself. Without this second atomic `wx`, two
  // contenders can both observe the same stale mtime, both overwrite the
  // lock and both believe they acquired it.
  const takeoverPath = `${lockPath}.takeover`;
  try {
    writeFileSync(takeoverPath, token, { encoding: "utf8", flag: "wx" });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    // A contender can itself crash after creating the takeover mutex. It is
    // a lease too, not a permanent tombstone. Removal races are harmless:
    // the retrying `wx` below still elects exactly one winner.
    try {
      const takeoverAgeMs = now.getTime() - statSync(takeoverPath).mtimeMs;
      if (takeoverAgeMs <= staleAfterMs) {
        return {
          acquired: false,
          reason: "stale-lock takeover already in progress",
        };
      }
      rmSync(takeoverPath);
      writeFileSync(takeoverPath, token, { encoding: "utf8", flag: "wx" });
    } catch (retryCause) {
      if ((retryCause as NodeJS.ErrnoException).code !== "EEXIST") {
        throw retryCause;
      }
      return {
        acquired: false,
        reason: "stale-lock takeover already in progress",
      };
    }
  }

  try {
    // Re-check after winning the takeover mutex: the owner may have emitted a
    // heartbeat between our first stat and this point.
    let currentAgeMs: number;
    try {
      currentAgeMs = now.getTime() - statSync(lockPath).mtimeMs;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      writeFileSync(lockPath, contents, { encoding: "utf8", flag: "wx" });
      return { acquired: true, token };
    }
    if (currentAgeMs <= staleAfterMs) {
      return {
        acquired: false,
        reason: `lock refreshed during takeover (${Math.round(currentAgeMs / 1000)}s old)`,
      };
    }
    rmSync(lockPath);
    writeFileSync(lockPath, contents, { encoding: "utf8", flag: "wx" });
    return { acquired: true, token };
  } finally {
    rmSync(takeoverPath, { force: true });
  }
}

function lockToken(lockPath: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
    return parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as { token?: unknown }).token === "string"
      ? (parsed as { token: string }).token
      : null;
  } catch {
    return null;
  }
}

/** Refreshes only the lease this caller owns. A replaced owner can never
 * keep another process's lock alive. */
export function refreshLock(
  lockPath: string,
  token: string,
  now: Date = new Date(),
): boolean {
  const takeoverPath = `${lockPath}.takeover`;
  try {
    // Serialize refresh/release with stale takeover. Without this guard, an
    // old owner could validate its token, lose the lock to a takeover, and
    // then touch or remove the replacement owner's file (a classic
    // check-then-act race).
    writeFileSync(takeoverPath, token, { encoding: "utf8", flag: "wx" });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw cause;
  }
  try {
    if (lockToken(lockPath) !== token) return false;
    // Heartbeat through mtime only. Rewriting the owner JSON had a TOCTOU:
    // a stale takeover could replace the lock after `lockToken` returned,
    // then the old owner would overwrite the new owner's token. Touching
    // mtime can at worst briefly extend a replacement lease; it never
    // changes ownership data.
    utimesSync(lockPath, now, now);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(takeoverPath, { force: true });
  }
}

/** Releases only the lease identified by `token`. An old process finishing
 * after a stale takeover cannot delete the new owner's lock. */
export function releaseLock(lockPath: string, token: string): void {
  const takeoverPath = `${lockPath}.takeover`;
  try {
    writeFileSync(takeoverPath, token, { encoding: "utf8", flag: "wx" });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") return;
    throw cause;
  }
  try {
    if (lockToken(lockPath) !== token) return;
    rmSync(lockPath);
  } catch {
    // Already gone.
  } finally {
    rmSync(takeoverPath, { force: true });
  }
}

/** Whether `id` needs a fresh Playwright page load this run — true for an
 * ID never seen before, or one currently `"retryable"`. False for
 * `"collected"` (has a payload, only needs ingest, not a page load again),
 * `"ingested"`/`"expired"` (terminal), and `"quarantined"` (past the retry
 * budget — excluded from automatic retry, not from the state file). */
export function needsPageFetch(state: CathoState, id: string): boolean {
  const entry = state.entries[id];
  return entry === undefined || entry.state === "retryable";
}

export type PageOutcome =
  | { readonly kind: "collected"; readonly payload: CathoPayload }
  | { readonly kind: "expired" }
  | { readonly kind: "retryable"; readonly reason: string };

/** The one confirmed expiration pattern from live discovery: a 2xx
 * response whose final URL is the bare listing page, `/vagas` or
 * `/vagas/` — never a bare "the URL changed" check, which a 403 or a
 * cookie-consent bounce could also trigger without the posting actually
 * being gone. */
function isGenericListingRedirect(finalUrl: string): boolean {
  try {
    const { pathname } = new URL(finalUrl);
    return pathname === "/vagas" || pathname === "/vagas/";
  } catch {
    return false;
  }
}

/**
 * Pure classification of one page-load attempt into exactly one of three
 * outcomes. No network call, no Playwright dependency — `collect.ts` gathers
 * the raw signals (status, final URL, parsed JSON-LD, page title) and hands
 * them here, which is what makes this testable without a browser.
 */
export function classifyPageResult(input: {
  readonly httpStatus: number | null;
  readonly finalUrl: string;
  readonly jsonLd: unknown;
  readonly pageTitle: string;
  readonly candidate: { readonly id: string; readonly url: string };
}): PageOutcome {
  const { httpStatus, finalUrl, jsonLd, pageTitle, candidate } = input;

  if (httpStatus === null) {
    return { kind: "retryable", reason: "no response" };
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    return { kind: "retryable", reason: `HTTP ${httpStatus}` };
  }
  // Revalidated here, not only on the sitemap-derived candidate URL
  // (docs/audit AC-034): the candidate could be a legitimate catho.com.br
  // URL and still redirect somewhere else entirely by the time the browser
  // settles. `retryable`, not a new terminal state — a same-run anomaly
  // like this deserves another look next cycle, not a permanent verdict.
  if (!isAllowedCathoUrl(finalUrl)) {
    return { kind: "retryable", reason: "final URL host not allowed" };
  }
  if (isGenericListingRedirect(finalUrl)) {
    return { kind: "expired" };
  }
  if (!jsonLd) {
    return { kind: "retryable", reason: "missing or invalid JSON-LD" };
  }
  return {
    kind: "collected",
    payload: {
      id: candidate.id,
      url: candidate.url,
      pageTitle,
      jobPosting: jsonLd,
    },
  };
}

/** Folds one page outcome into the state, returning a new `CathoState`
 * (never mutates its input — every caller here works on an in-memory
 * accumulator across a run, and accidental aliasing would be a real bug
 * class for a file this project only ever reads once per run). */
export function applyPageOutcome(
  state: CathoState,
  id: string,
  outcome: PageOutcome,
): CathoState {
  const entries = { ...state.entries };
  if (outcome.kind === "collected") {
    entries[id] = { state: "collected", payload: outcome.payload };
  } else if (outcome.kind === "expired") {
    entries[id] = { state: "expired" };
  } else {
    const failCount = (state.entries[id]?.failCount ?? 0) + 1;
    entries[id] =
      failCount >= MAX_RETRYABLE_ATTEMPTS_BEFORE_QUARANTINE
        ? { state: "quarantined", failCount, reason: outcome.reason }
        : { state: "retryable", failCount, reason: outcome.reason };
  }
  return { version: 2, entries };
}

/**
 * Reopens quarantined entries for another attempt (docs/audit PR-011) —
 * the "explicit retry/reconciliation control" a quarantine has otherwise
 * never had: past the retry budget, `needsPageFetch` returns `false`
 * forever and no other code path in this collector ever revisits an ID
 * again. Removes the entry entirely rather than resetting it to
 * `"retryable"` with `failCount: 0` — an absent ID and a fresh ID mean the
 * exact same thing to `needsPageFetch`/`toCandidate`, so this is not a new
 * state, just forgetting the old verdict and letting the ID compete for
 * this run's budget like any other unseen candidate.
 *
 * `ids: undefined` requeues every quarantined entry in the state. An `id`
 * that does not exist, or exists but is not quarantined, is silently
 * skipped — `requeued` names exactly what changed, so a caller can tell
 * a typo'd ID from a real one without a thrown error over an operator
 * mistake.
 */
export function requeueQuarantined(
  state: CathoState,
  ids?: readonly string[],
): { readonly state: CathoState; readonly requeued: readonly string[] } {
  const targets =
    ids ??
    Object.entries(state.entries)
      .filter(([, entry]) => entry.state === "quarantined")
      .map(([id]) => id);

  const entries = { ...state.entries };
  const requeued: string[] = [];
  for (const id of targets) {
    if (entries[id]?.state === "quarantined") {
      delete entries[id];
      requeued.push(id);
    }
  }
  return { state: { version: 2, entries }, requeued };
}

/** Every payload waiting on a durable ingest confirmation — collected this
 * run or left over from a previous run whose ingest POST never succeeded.
 * Independent of the current run's sitemap scan: an ID that dropped out of
 * today's sitemap (delisted, or just paginated differently) still gets its
 * pending payload retried, because this reads the state file, not the
 * candidate list. */
export function collectedPayloadsPendingIngest(
  state: CathoState,
): CathoPayload[] {
  const payloads: CathoPayload[] = [];
  for (const entry of Object.values(state.entries)) {
    if (entry.state === "collected" && entry.payload)
      payloads.push(entry.payload);
  }
  return payloads;
}

/** Marks every listed ID `"ingested"` — call only after a confirmed 2xx
 * from `POST /runs/collect/external`. An ID not currently `"collected"` is
 * left untouched (defensive: this should never happen given how the batch
 * is built, but silently ignoring a mismatch is safer than throwing mid-run
 * over a bookkeeping inconsistency). */
export function markIngested(
  state: CathoState,
  ids: readonly string[],
): CathoState {
  const entries = { ...state.entries };
  for (const id of ids) {
    if (entries[id]?.state === "collected") entries[id] = { state: "ingested" };
  }
  return { version: 2, entries };
}
