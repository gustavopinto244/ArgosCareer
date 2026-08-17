#!/usr/bin/env node
/**
 * Reopens quarantined Catho entries for another attempt (docs/audit
 * PR-011) — the "explicit retry/reconciliation control" a quarantine
 * otherwise never had. Past `MAX_RETRYABLE_ATTEMPTS_BEFORE_QUARANTINE`
 * consecutive failures, `needsPageFetch` returns `false` forever and
 * `collect.ts`'s normal run never revisits an ID again; the only way back
 * used to be editing the state file by hand. Reason: `state.ts`'s
 * `CathoStateEntry.reason` now carries the most recent failure's own
 * message (also PR-011), so a human can tell "this is Catho's known 403"
 * from "this ID has genuinely never loaded" before deciding whether
 * requeuing is even the right call.
 *
 * One run, one exit, same shape as `collect.ts` and
 * `collectors/indeed/collect.py` — no daemon, no schedule of its own; run
 * by hand once a quarantine's cause (a Catho block, a bug) is understood
 * to be resolved.
 *
 * Usage:
 *   npx tsx requeue.ts --all        # every quarantined entry
 *   npx tsx requeue.ts <id> [id...] # specific IDs only
 *
 * Optional environment:
 *   STATE_PATH (default /data/catho-state.json, same as collect.ts)
 */
import { loadState, requeueQuarantined, saveStateAtomic } from "./state";

const DEFAULT_STATE_PATH = "/data/catho-state.json";

function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function main(): void {
  const args = process.argv.slice(2);
  const requeueAll = args.includes("--all");
  const ids = args.filter((a) => a !== "--all");

  if (!requeueAll && ids.length === 0) {
    console.error("Usage: requeue.ts --all | <id> [id...]");
    process.exitCode = 1;
    return;
  }

  const statePath = env("STATE_PATH", DEFAULT_STATE_PATH);
  const state = loadState(statePath);

  const result = requeueQuarantined(state, requeueAll ? undefined : ids);

  if (result.requeued.length === 0) {
    console.log("nothing requeued -- no matching quarantined entries");
    return;
  }

  saveStateAtomic(statePath, result.state);
  console.log(
    `requeued ${result.requeued.length} entry(ies): ${result.requeued.join(", ")}`,
  );
}

main();
