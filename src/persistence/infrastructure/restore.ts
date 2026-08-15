import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";

export type RestoreResult =
  { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * Replaces `databasePath` with `backupPath` (docs/10-milestones.md, M8).
 * Refuses rather than corrupting an in-progress write: an unfinished `runs`
 * row (`finishedAt IS NULL`) means a collect/dedup/deliver cycle is
 * mid-flight, and overwriting the live file underneath it would leave that
 * cycle writing to a file that no longer matches what it started with.
 *
 * Not a guarantee against every race — this is a manual, rare admin
 * operation expected to run with the app stopped, not a lock. It is a
 * sanity check against the common accident, not a distributed-systems
 * correctness proof.
 */
export function restoreDatabase(
  backupPath: string,
  databasePath: string,
): RestoreResult {
  if (!existsSync(backupPath)) {
    return { ok: false, error: `Backup file not found: ${backupPath}` };
  }

  const validity = validateBackup(backupPath);
  if (!validity.ok) return validity;

  if (existsSync(databasePath)) {
    const liveCheck = checkNotMidRun(databasePath);
    if (!liveCheck.ok) return liveCheck;
  }

  copyFileSync(backupPath, databasePath);
  // The restored file is a fresh, non-WAL snapshot (VACUUM INTO's output);
  // stale -wal/-shm sidecars from the file it replaced would otherwise be
  // read as if they belonged to it.
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${databasePath}${suffix}`;
    if (existsSync(sidecar)) unlinkSync(sidecar);
  }

  return { ok: true };
}

function validateBackup(backupPath: string): RestoreResult {
  try {
    const db = new Database(backupPath, { readonly: true });
    try {
      db.prepare("SELECT 1").get();
    } finally {
      db.close();
    }
    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      error: `Backup file is not a readable SQLite database: ${(cause as Error).message}`,
    };
  }
}

/**
 * A raw connection, not `createDatabase` — this is a one-shot read that
 * must not outlive the function (a lingering handle would itself lock the
 * file `copyFileSync` is about to overwrite), and it must not depend on
 * `runMigrations` having already run against whatever is on disk.
 */
function checkNotMidRun(databasePath: string): RestoreResult {
  const db = new Database(databasePath, { readonly: true });
  try {
    const unfinished = db
      .prepare("SELECT run_id FROM runs WHERE finished_at IS NULL LIMIT 1")
      .get() as { run_id: string } | undefined;

    if (unfinished) {
      return {
        ok: false,
        error: `Refusing to restore: run ${unfinished.run_id} looks unfinished (no finishedAt). Stop the app first.`,
      };
    }
    return { ok: true };
  } finally {
    db.close();
  }
}
