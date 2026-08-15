import Database from "better-sqlite3";
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface BackupResult {
  readonly path: string;
  readonly deletedOldBackups: readonly string[];
}

const BACKUP_FILE_PATTERN = /^argos-.*\.db$/;

/**
 * `VACUUM INTO` a timestamped file, then prune anything past `retention`
 * (docs/10-milestones.md, M8). Safe against a live, WAL-mode connection —
 * unlike a raw file copy, which can capture a half-written page mid-write —
 * because it reads through SQLite's own consistent-snapshot machinery
 * rather than touching the file bytes directly.
 *
 * Filenames encode the timestamp so lexicographic and chronological order
 * coincide — no separate index or metadata file needed to know which
 * backup is newest.
 */
export function backupDatabase(
  databasePath: string,
  backupsDir: string,
  now: () => Date = () => new Date(),
  retention = 7,
): BackupResult {
  mkdirSync(backupsDir, { recursive: true });

  const timestamp = now().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(backupsDir, `argos-${timestamp}.db`);

  const db = new Database(databasePath);
  try {
    db.prepare("VACUUM INTO ?").run(backupPath);
  } finally {
    db.close();
  }

  const deletedOldBackups = enforceRetention(backupsDir, retention);
  return { path: backupPath, deletedOldBackups };
}

function enforceRetention(backupsDir: string, retention: number): string[] {
  const backups = readdirSync(backupsDir)
    .filter((name) => BACKUP_FILE_PATTERN.test(name))
    .sort() // ISO-timestamped names: lexicographic order is chronological.
    .reverse(); // Newest first.

  const toDelete = backups.slice(retention);
  for (const name of toDelete) unlinkSync(join(backupsDir, name));
  return toDelete;
}
