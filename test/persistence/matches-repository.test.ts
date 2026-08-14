import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  runMigrations,
} from "../../src/persistence/infrastructure/db";
import { MatchesRepository } from "../../src/persistence/infrastructure/matches-repository";
import { createMatch, Match } from "../../src/scoring/domain/types";

let dir: string;
let repository: MatchesRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argos-matches-"));
  const db = createDatabase(join(dir, "argos.db"));
  runMigrations(db);
  repository = new MatchesRepository(db);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function matchList(): Match[] {
  return [
    createMatch(
      { text: "Node.js experience", category: "language", weight: "mandatory" },
      "met",
      "Built atlas-manager's HTTP layer in Node.js.",
    ),
  ];
}

describe("MatchesRepository", () => {
  it("returns null for a key that was never stored", () => {
    expect(repository.find("fp1", "hash1", "b-v1")).toBeNull();
  });

  it("stores and retrieves matches for a (fingerprint, profileHash, promptVersion) key", () => {
    repository.upsert("fp1", "hash1", "b-v1", matchList(), new Date());
    expect(repository.find("fp1", "hash1", "b-v1")).toEqual(matchList());
  });

  it("invalidates cached matches when the profile hash changes", () => {
    repository.upsert("fp1", "hash1", "b-v1", matchList(), new Date());
    expect(repository.find("fp1", "hash2", "b-v1")).toBeNull();
  });

  it("keeps results for different prompt versions independent", () => {
    repository.upsert("fp1", "hash1", "b-v1", matchList(), new Date());
    expect(repository.find("fp1", "hash1", "b-v2")).toBeNull();
  });

  it("upserting the same key overwrites, not duplicates", () => {
    repository.upsert("fp1", "hash1", "b-v1", matchList(), new Date());
    repository.upsert("fp1", "hash1", "b-v1", [], new Date());

    expect(repository.find("fp1", "hash1", "b-v1")).toEqual([]);
  });
});
