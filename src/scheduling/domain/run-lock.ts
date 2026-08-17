/**
 * An in-process, in-memory guard against two attempts at the same kind of
 * run overlapping — `collect`, `dedup`, `scoreAndDeliver` (`RunsRepository`'s
 * free-string `kind`, reused here rather than a new enum).
 *
 * Exists because `SchedulerService`'s cron ticks, `RunsService`'s REST/MCP
 * stage-trigger methods, and the CLI's commands are four independent ways
 * to start the same core `execute*` function (principle 2), and until now
 * nothing stopped two of them from starting the same one at the same time —
 * demonstrated in practice hitting `POST /runs/deliver` manually while the
 * scheduled cycle's own multi-hour run was still in flight. A second
 * `scoreAndDeliver` starting before the first finishes reads the same
 * `findUnnotified()` candidate pool neither has marked notified yet, scores
 * it twice, and can send the same postings to Telegram in two separate
 * digests (ADR-024's context has the full reasoning).
 *
 * In-memory is enough for its own job because collection and delivery share
 * one process (`app.module.ts`: "one process, both concerns") — `RunsService`
 * and `SchedulerService` inject the exact same instance via the `RUN_LOCK`
 * token (`run-lock.provider.ts`). It does **not** protect against a
 * separately-invoked CLI process racing the running server — a different
 * Node process gets its own empty lock — which ADR-024 states as a known,
 * accepted limitation of this class specifically, not something it silently
 * promises to cover.
 *
 * That specific cross-process gap, for the one place it actually mattered
 * (two `scoreAndDeliver` runs both selecting the same postings for paid
 * scoring), is now closed one layer down instead: `PostingsRepository`'s
 * `claimForScoring`/`releaseUnresolvedClaims` (docs/audit PR-004, ADR-040)
 * make the *selection* of scoring candidates a single, database-enforced
 * transaction, so a second process's own selection genuinely cannot
 * overlap with the first's — a guarantee this in-memory class could never
 * offer no matter how it was built. `RunLock` still exists and still
 * matters within one process: it avoids wasted duplicate work
 * (re-collecting, re-scoring what's already in flight) cheaply, without
 * a database round trip.
 */
export class RunLock {
  private readonly active = new Set<string>();

  /** `true` and marks `kind` in-flight if it was free; `false` and leaves
   * state untouched if `kind` was already held. */
  tryAcquire(kind: string): boolean {
    if (this.active.has(kind)) return false;
    this.active.add(kind);
    return true;
  }

  release(kind: string): void {
    this.active.delete(kind);
  }

  isActive(kind: string): boolean {
    return this.active.has(kind);
  }
}

export type RunExclusiveResult<T> =
  { readonly ok: true; readonly result: T } | { readonly ok: false };

/**
 * Runs `fn` under `kind`'s lock, releasing it whether `fn` resolves or
 * throws — `finally`, not a bare `release()` after `await`, specifically so
 * a throw out of `fn` (the exact case `executeDeliver`'s own bookkeeping
 * fix had to add — a prompt template missing, a thrown network error)
 * cannot leave the lock permanently held, which would be strictly worse
 * than the orphaned-run problem this project already fixed once.
 *
 * Returns `{ ok: false }` rather than throwing when the lock is already
 * held — a caller busy with the wrong stage is an expected, benign outcome
 * for a scheduler tick (log and skip this cycle) and a distinct one from an
 * actual failure for an HTTP/MCP caller (translate to 409), so the two
 * callers' different reactions belong in the caller, not baked in here.
 */
export async function runExclusive<T>(
  lock: RunLock,
  kind: string,
  fn: () => Promise<T>,
): Promise<RunExclusiveResult<T>> {
  if (!lock.tryAcquire(kind)) return { ok: false };
  try {
    return { ok: true, result: await fn() };
  } finally {
    lock.release(kind);
  }
}
