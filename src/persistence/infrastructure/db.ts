import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;

// Resolves to <repo root>/drizzle regardless of dev (tsx from src/) or built
// (dist/, which mirrors src/ one level for one level — see
// tsconfig.build.json) — both are three directories below the repo root.
const MIGRATIONS_FOLDER = join(__dirname, "..", "..", "..", "drizzle");

/**
 * `journal_mode = WAL` so a read during a write does not block — relevant
 * once the CLI and, later, a scheduled batch (M8) touch the same file.
 */
export function createDatabase(databasePath: string): Db {
  if (databasePath !== ":memory:")
    mkdirSync(dirname(databasePath), { recursive: true });
  const sqlite = new Database(databasePath);
  sqlite.pragma("journal_mode = WAL");
  return drizzle(sqlite, { schema });
}

/**
 * Config is read once at startup (docs/09-configuration.md); migrating is
 * the same shape of operation — run forward from whatever the file already
 * has, including from empty, and fail loudly if a migration cannot apply.
 */
export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
