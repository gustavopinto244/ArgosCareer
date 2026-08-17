import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createDatabase,
  Db,
  runMigrations,
} from "../../src/persistence/infrastructure/db";
import { MatchesRepository } from "../../src/persistence/infrastructure/matches-repository";
import { createMatch, Match } from "../../src/scoring/domain/types";

let dir: string;
let db: Db;
let repository: MatchesRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argos-matches-"));
  db = createDatabase(join(dir, "argos.db"));
  runMigrations(db);
  repository = new MatchesRepository(db);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const MODEL_A = "model-a";
const MODEL_B = "model-b";
const REQ_HASH_A = "requirements-hash-a";
const REQ_HASH_B = "requirements-hash-b";

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
    expect(
      repository.find("fp1", "hash1", "b-v1", MODEL_A, REQ_HASH_A),
    ).toBeNull();
  });

  it("stores and retrieves matches for a (fingerprint, profileHash, promptVersion) key", () => {
    repository.upsert(
      "fp1",
      "hash1",
      "b-v1",
      MODEL_A,
      REQ_HASH_A,
      matchList(),
      new Date(),
    );
    expect(
      repository.find("fp1", "hash1", "b-v1", MODEL_A, REQ_HASH_A),
    ).toEqual(matchList());
  });

  it("invalidates cached matches when the profile hash changes", () => {
    repository.upsert(
      "fp1",
      "hash1",
      "b-v1",
      MODEL_A,
      REQ_HASH_A,
      matchList(),
      new Date(),
    );
    expect(
      repository.find("fp1", "hash2", "b-v1", MODEL_A, REQ_HASH_A),
    ).toBeNull();
  });

  it("keeps results for different prompt versions independent", () => {
    repository.upsert(
      "fp1",
      "hash1",
      "b-v1",
      MODEL_A,
      REQ_HASH_A,
      matchList(),
      new Date(),
    );
    expect(
      repository.find("fp1", "hash1", "b-v2", MODEL_A, REQ_HASH_A),
    ).toBeNull();
  });

  it("upserting the same key overwrites, not duplicates", () => {
    repository.upsert(
      "fp1",
      "hash1",
      "b-v1",
      MODEL_A,
      REQ_HASH_A,
      matchList(),
      new Date(),
    );
    repository.upsert(
      "fp1",
      "hash1",
      "b-v1",
      MODEL_A,
      REQ_HASH_A,
      [],
      new Date(),
    );

    expect(
      repository.find("fp1", "hash1", "b-v1", MODEL_A, REQ_HASH_A),
    ).toEqual([]);
  });

  describe("requirementsHash and model (docs/audit AC-007, PR-017)", () => {
    it("treats a mismatched requirementsHash as a cache miss", () => {
      repository.upsert(
        "fp1",
        "hash1",
        "b-v1",
        MODEL_A,
        REQ_HASH_A,
        matchList(),
        new Date(),
      );
      expect(
        repository.find("fp1", "hash1", "b-v1", MODEL_A, REQ_HASH_B),
      ).toBeNull();
    });

    it("treats a mismatched model as a cache miss", () => {
      repository.upsert(
        "fp1",
        "hash1",
        "b-v1",
        MODEL_A,
        REQ_HASH_A,
        matchList(),
        new Date(),
      );
      expect(
        repository.find("fp1", "hash1", "b-v1", MODEL_B, REQ_HASH_A),
      ).toBeNull();
    });

    it("keeps both requirement sets independently retrievable under the same fingerprint/profileHash/promptVersion/model (docs/audit PR-017)", () => {
      // The exact bug PR-017 names: a Stage A prompt-version bump or a
      // content-hash-triggered re-extraction changes the requirement set
      // without touching fingerprint/profileHash/promptVersion from Stage
      // B's point of view -- the old key kept getting overwritten by the
      // new requirement set's match instead of the two coexisting.
      repository.upsert(
        "fp1",
        "hash1",
        "b-v1",
        MODEL_A,
        REQ_HASH_A,
        matchList(),
        new Date(),
      );
      repository.upsert(
        "fp1",
        "hash1",
        "b-v1",
        MODEL_A,
        REQ_HASH_B,
        [],
        new Date(),
      );

      expect(
        repository.find("fp1", "hash1", "b-v1", MODEL_A, REQ_HASH_A),
      ).toEqual(matchList());
      expect(
        repository.find("fp1", "hash1", "b-v1", MODEL_A, REQ_HASH_B),
      ).toEqual([]);
    });

    it("keeps both models' matches independently retrievable under the same fingerprint/profileHash/promptVersion/requirementsHash (docs/audit PR-017)", () => {
      repository.upsert(
        "fp1",
        "hash1",
        "b-v1",
        MODEL_A,
        REQ_HASH_A,
        matchList(),
        new Date(),
      );
      repository.upsert(
        "fp1",
        "hash1",
        "b-v1",
        MODEL_B,
        REQ_HASH_A,
        [],
        new Date(),
      );

      expect(
        repository.find("fp1", "hash1", "b-v1", MODEL_A, REQ_HASH_A),
      ).toEqual(matchList());
      expect(
        repository.find("fp1", "hash1", "b-v1", MODEL_B, REQ_HASH_A),
      ).toEqual([]);
    });

    it("treats a legacy row with no stored requirementsHash/model as a miss", () => {
      db.run(
        sql`INSERT INTO matches (fingerprint, profile_hash, prompt_version, matches, matched_at) VALUES ('fp1', 'hash1', 'b-v1', '[]', ${Date.now()})`,
      );
      expect(
        repository.find("fp1", "hash1", "b-v1", MODEL_A, REQ_HASH_A),
      ).toBeNull();
    });
  });

  describe("corrupted cache rows (docs/audit AC-031, PR-013)", () => {
    it("find treats truncated JSON as a cache miss instead of throwing", () => {
      repository.upsert(
        "fp1",
        "hash1",
        "b-v1",
        MODEL_A,
        REQ_HASH_A,
        matchList(),
        new Date(),
      );
      // A real restore/manual-edit scenario, not a mock -- write truncated
      // JSON directly into the column, bypassing upsert's own JSON.stringify.
      db.run(
        sql`UPDATE matches SET matches = '[{"requirement"' WHERE fingerprint = 'fp1'`,
      );

      expect(() =>
        repository.find("fp1", "hash1", "b-v1", MODEL_A, REQ_HASH_A),
      ).not.toThrow();
      expect(
        repository.find("fp1", "hash1", "b-v1", MODEL_A, REQ_HASH_A),
      ).toBeNull();
    });

    it("find treats valid JSON that is not an array as a cache miss", () => {
      repository.upsert(
        "fp1",
        "hash1",
        "b-v1",
        MODEL_A,
        REQ_HASH_A,
        matchList(),
        new Date(),
      );
      db.run(
        sql`UPDATE matches SET matches = '{"not": "an array"}' WHERE fingerprint = 'fp1'`,
      );

      expect(
        repository.find("fp1", "hash1", "b-v1", MODEL_A, REQ_HASH_A),
      ).toBeNull();
    });

    it("find treats a structurally-valid-JSON array of domain-invalid elements as a cache miss", () => {
      // The exact gap PR-013 names: [{}] and [null] are both valid JSON and
      // both real arrays -- Array.isArray alone accepted them as if they
      // were real Match[].
      repository.upsert(
        "fp1",
        "hash1",
        "b-v1",
        MODEL_A,
        REQ_HASH_A,
        matchList(),
        new Date(),
      );
      db.run(
        sql`UPDATE matches SET matches = '[{}]' WHERE fingerprint = 'fp1'`,
      );
      expect(
        repository.find("fp1", "hash1", "b-v1", MODEL_A, REQ_HASH_A),
      ).toBeNull();
    });

    it("find rejects an invalid status enum on an otherwise well-formed match", () => {
      repository.upsert(
        "fp1",
        "hash1",
        "b-v1",
        MODEL_A,
        REQ_HASH_A,
        matchList(),
        new Date(),
      );
      db.run(
        sql`UPDATE matches SET matches = '[{"requirement":{"text":"Node.js","category":"language","weight":"mandatory"},"status":"maybe","evidence":"x"}]' WHERE fingerprint = 'fp1'`,
      );
      expect(
        repository.find("fp1", "hash1", "b-v1", MODEL_A, REQ_HASH_A),
      ).toBeNull();
    });

    it("find rejects a match whose nested requirement is not a valid Requirement", () => {
      db.run(
        sql`INSERT INTO matches (fingerprint, profile_hash, prompt_version, matches, requirements_hash, model, matched_at) VALUES ('fp1', 'hash1', 'b-v1', '[{"requirement":{},"status":"met","evidence":"x"}]', ${REQ_HASH_A}, ${MODEL_A}, ${Date.now()})`,
      );
      expect(
        repository.find("fp1", "hash1", "b-v1", MODEL_A, REQ_HASH_A),
      ).toBeNull();
    });
  });
});
