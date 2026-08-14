import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  runMigrations,
} from "../../src/persistence/infrastructure/db";

// Real temporary SQLite files, not a mock (docs/07-testing-strategy.md).
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argos-db-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runMigrations", () => {
  it("runs forward from an empty database", () => {
    const db = createDatabase(join(dir, "argos.db"));

    runMigrations(db);

    const tables = db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table'`,
    );
    const names = tables.map((t) => t.name);
    expect(names).toContain("postings");
    expect(names).toContain("runs");
  });

  it("is idempotent — running it twice does not error", () => {
    const db = createDatabase(join(dir, "argos.db"));

    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });

  it("creates the parent directory if it does not exist yet", () => {
    const nestedPath = join(dir, "nested", "does", "not", "exist", "argos.db");
    expect(() => createDatabase(nestedPath)).not.toThrow();
  });
});
