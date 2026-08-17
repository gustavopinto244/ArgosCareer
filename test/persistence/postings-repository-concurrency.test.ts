import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { createPosting } from "../../src/posting/domain/posting";
import {
  createDatabase,
  Db,
  runMigrations,
} from "../../src/persistence/infrastructure/db";
import { PostingsRepository } from "../../src/persistence/infrastructure/postings-repository";

/**
 * Real second connection to the same SQLite file, not a mock or a
 * simulation — the actual scenario docs/audit AC-020 raised: a second OS
 * process (or here, a second `better-sqlite3` handle, which is what a
 * second process would also open) touching the same database file
 * concurrently with `PostingsRepository`.
 */
let dir: string;
let dbPath: string;
let db: Db;
let repository: PostingsRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argos-postings-concurrency-"));
  dbPath = join(dir, "argos.db");
  db = createDatabase(dbPath);
  runMigrations(db);
  repository = new PostingsRepository(db);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function posting(overrides: Partial<Parameters<typeof createPosting>[0]> = {}) {
  return createPosting({
    source: "gupy",
    sourceId: "123",
    company: "Empresa X",
    title: "Estágio Backend",
    location: { kind: "known", city: "Rio de Janeiro" },
    workMode: "hybrid",
    collectedAt: new Date("2026-08-14T03:00:00Z"),
    firstSeenAt: new Date("2026-08-14T03:00:00Z"),
    lastSeenAt: new Date("2026-08-14T03:00:00Z"),
    rawPayload: { id: 123 },
    ...overrides,
  });
}

describe("PostingsRepository.upsert — cross-process write serialization (docs/audit AC-020)", () => {
  it("blocks a second connection's write transaction rather than interleaving it, while one is open", () => {
    // A second, genuinely separate connection to the same file, holding its
    // own open write transaction -- exactly what a second OS process racing
    // this repository would look like at the SQLite level.
    const rival = new BetterSqlite3(dbPath);
    rival.pragma("journal_mode = WAL");
    rival.prepare("BEGIN IMMEDIATE").run();
    // Short busy_timeout on the repository's own connection so this test
    // does not wait out better-sqlite3's 5s default before failing.
    (db as unknown as { $client: BetterSqlite3.Database }).$client.pragma(
      "busy_timeout = 200",
    );

    try {
      // upsert's select-then-branch is inside one db.transaction() (its own
      // BEGIN/COMMIT) -- with the rival connection already holding the
      // write lock, this must be blocked out entirely (SQLITE_BUSY), never
      // allowed to interleave a read and a write with the rival's open
      // transaction and silently corrupt or double-write the row.
      expect(() => repository.upsert(posting())).toThrow(
        /SQLITE_BUSY|busy|locked/i,
      );
    } finally {
      rival.prepare("COMMIT").run();
      rival.close();
    }

    // Once the rival releases its lock, the same write succeeds normally --
    // proving this was serialization (blocked, then free to proceed), not a
    // permanent failure or corrupted state.
    const result = repository.upsert(posting());
    expect(result.wasNew).toBe(true);
    expect(
      repository.findByFingerprint(result.posting.fingerprint),
    ).not.toBeNull();
  });
});
