import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  runMigrations,
} from "../../../src/persistence/infrastructure/db";
import * as schema from "../../../src/persistence/infrastructure/schema";
import { runs } from "../../../src/persistence/infrastructure/schema";
import { backupDatabase } from "../../../src/persistence/infrastructure/backup";
import { restoreDatabase } from "../../../src/persistence/infrastructure/restore";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argos-restore-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function migratedDb(path: string) {
  const db = createDatabase(path);
  runMigrations(db);
  return db;
}

describe("restoreDatabase", () => {
  it("replaces the live database with the backup's contents", () => {
    const backupSource = join(dir, "source.db");
    const db = migratedDb(backupSource);
    db.insert(runs)
      .values({ runId: "run-1", kind: "collect", startedAt: new Date() })
      .run();
    const backup = backupDatabase(backupSource, join(dir, "backups"));

    // A different, empty live database — closed explicitly so it does not
    // hold the file open underneath `copyFileSync` (and the read that
    // verifies the result, below).
    const liveDatabasePath = join(dir, "argos.db");
    const rawClient = new Database(liveDatabasePath);
    runMigrations(drizzle(rawClient, { schema }));
    rawClient.close();

    const result = restoreDatabase(backup.path, liveDatabasePath);

    expect(result.ok).toBe(true);
    const restored = createDatabase(liveDatabasePath);
    const row = restored.select().from(runs).get();
    expect(row?.runId).toBe("run-1");
  });

  it("creates the database when none exists yet at the target path", () => {
    const backupSource = join(dir, "source.db");
    migratedDb(backupSource);
    const backup = backupDatabase(backupSource, join(dir, "backups"));

    const liveDatabasePath = join(dir, "fresh.db");
    const result = restoreDatabase(backup.path, liveDatabasePath);

    expect(result.ok).toBe(true);
    expect(existsSync(liveDatabasePath)).toBe(true);
  });

  it("fails with a named reason when the backup file does not exist", () => {
    const result = restoreDatabase(
      join(dir, "does-not-exist.db"),
      join(dir, "argos.db"),
    );
    expect(result).toEqual({
      ok: false,
      error: `Backup file not found: ${join(dir, "does-not-exist.db")}`,
    });
  });

  it("fails with a named reason when the backup file is not a valid SQLite database", () => {
    const notADb = join(dir, "not-a-db.db");
    writeFileSync(notADb, "this is not sqlite");

    const result = restoreDatabase(notADb, join(dir, "argos.db"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not a readable SQLite database");
    }
  });

  it("refuses to restore over a live database with an unfinished run", () => {
    const backupSource = join(dir, "source.db");
    migratedDb(backupSource);
    const backup = backupDatabase(backupSource, join(dir, "backups"));

    const liveDatabasePath = join(dir, "argos.db");
    const liveDb = migratedDb(liveDatabasePath);
    liveDb
      .insert(runs)
      .values({ runId: "in-progress", kind: "collect", startedAt: new Date() })
      .run(); // finishedAt left null — mid-run

    const result = restoreDatabase(backup.path, liveDatabasePath);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("in-progress");
    }
  });

  it("allows restoring when the live database's runs all finished", () => {
    const backupSource = join(dir, "source.db");
    migratedDb(backupSource);
    const backup = backupDatabase(backupSource, join(dir, "backups"));

    const liveDatabasePath = join(dir, "argos.db");
    const liveDb = migratedDb(liveDatabasePath);
    liveDb
      .insert(runs)
      .values({
        runId: "done",
        kind: "collect",
        startedAt: new Date(),
        finishedAt: new Date(),
        outcome: "success",
      })
      .run();

    const result = restoreDatabase(backup.path, liveDatabasePath);

    expect(result.ok).toBe(true);
  });

  it("removes stale -wal/-shm sidecars left by the file it replaces", () => {
    const backupSource = join(dir, "source.db");
    migratedDb(backupSource);
    const backup = backupDatabase(backupSource, join(dir, "backups"));

    const liveDatabasePath = join(dir, "argos.db");
    // A raw connection, closed explicitly — a "stale" sidecar only exists
    // once the connection that produced it is gone, so the setup has to
    // actually close it rather than leaving `migratedDb`'s handle open
    // underneath the garbage this test writes into -wal/-shm next.
    const rawClient = new Database(liveDatabasePath);
    runMigrations(drizzle(rawClient, { schema }));
    rawClient.close();
    const walPath = `${liveDatabasePath}-wal`;
    const shmPath = `${liveDatabasePath}-shm`;
    writeFileSync(walPath, "stale wal");
    writeFileSync(shmPath, "stale shm");

    restoreDatabase(backup.path, liveDatabasePath);

    expect(existsSync(walPath)).toBe(false);
    expect(existsSync(shmPath)).toBe(false);
  });
});
