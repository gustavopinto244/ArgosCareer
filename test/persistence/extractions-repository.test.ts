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
import {
  ExtractionRecord,
  ExtractionsRepository,
} from "../../src/persistence/infrastructure/extractions-repository";

let dir: string;
let db: Db;
let repository: ExtractionsRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argos-extractions-"));
  db = createDatabase(join(dir, "argos.db"));
  runMigrations(db);
  repository = new ExtractionsRepository(db);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const HASH_A = "content-hash-a";
const HASH_B = "content-hash-b";
const MODEL_A = "model-a";
const MODEL_B = "model-b";

function record(overrides: Partial<ExtractionRecord> = {}): ExtractionRecord {
  return {
    requirements: [
      { text: "Node.js experience", category: "language", weight: "mandatory" },
      { text: "SQL", category: "database", weight: "desirable" },
    ],
    seniority: null,
    experienceYears: null,
    ...overrides,
  };
}

describe("ExtractionsRepository", () => {
  it("returns null for a fingerprint/promptVersion pair that was never stored", () => {
    expect(repository.find("fp1", "a-v1", MODEL_A, HASH_A)).toBeNull();
  });

  it("stores and retrieves a full extraction record for a (fingerprint, promptVersion, contentHash) key", () => {
    repository.upsert("fp1", "a-v1", MODEL_A, HASH_A, record(), new Date());
    expect(repository.find("fp1", "a-v1", MODEL_A, HASH_A)).toEqual(record());
  });

  it("stores seniority and experienceYears alongside requirements", () => {
    repository.upsert(
      "fp1",
      "a-v1",
      MODEL_A,
      HASH_A,
      record({ seniority: "internship", experienceYears: 0 }),
      new Date(),
    );
    const found = repository.find("fp1", "a-v1", MODEL_A, HASH_A);
    expect(found?.seniority).toBe("internship");
    expect(found?.experienceYears).toBe(0);
  });

  it("keeps results for different prompt versions of the same posting independent", () => {
    repository.upsert("fp1", "a-v1", MODEL_A, HASH_A, record(), new Date());
    repository.upsert(
      "fp1",
      "a-v2",
      MODEL_A,
      HASH_A,
      record({ requirements: [] }),
      new Date(),
    );

    expect(repository.find("fp1", "a-v1", MODEL_A, HASH_A)).toEqual(record());
    expect(
      repository.find("fp1", "a-v2", MODEL_A, HASH_A)?.requirements,
    ).toEqual([]);
  });

  it("upserting the exact same composite key overwrites, not duplicates", () => {
    repository.upsert("fp1", "a-v1", MODEL_A, HASH_A, record(), new Date());
    repository.upsert(
      "fp1",
      "a-v1",
      MODEL_A,
      HASH_A,
      record({ requirements: [] }),
      new Date(),
    );

    expect(
      repository.find("fp1", "a-v1", MODEL_A, HASH_A)?.requirements,
    ).toEqual([]);
  });

  describe("content hash (docs/audit AC-006)", () => {
    it("treats a mismatched contentHash as a cache miss, even for the same fingerprint/promptVersion", () => {
      repository.upsert("fp1", "a-v1", MODEL_A, HASH_A, record(), new Date());
      expect(repository.find("fp1", "a-v1", MODEL_A, HASH_B)).toBeNull();
    });

    it("keeps both content hashes independently retrievable under the same fingerprint/promptVersion/model (docs/audit PR-017)", () => {
      // The exact bug PR-017 names: a description edited and then reverted
      // used to evict the still-valid first extraction, because the row's
      // actual database identity was only (fingerprint, promptVersion) --
      // contentHash was checked only after a row was already found. Both
      // must now coexist as their own rows.
      repository.upsert(
        "fp1",
        "a-v1",
        MODEL_A,
        HASH_A,
        record({ requirements: [] }),
        new Date(),
      );
      repository.upsert(
        "fp1",
        "a-v1",
        MODEL_A,
        HASH_B,
        record({ seniority: "internship" }),
        new Date(),
      );

      expect(
        repository.find("fp1", "a-v1", MODEL_A, HASH_A)?.requirements,
      ).toEqual([]);
      expect(repository.find("fp1", "a-v1", MODEL_A, HASH_B)?.seniority).toBe(
        "internship",
      );
    });

    it("treats a legacy row with no stored contentHash as a miss", () => {
      // A real pre-AC-006 row, not a mock -- insert directly with no
      // content_hash, bypassing upsert entirely.
      db.run(
        sql`INSERT INTO extractions (fingerprint, prompt_version, requirements, extracted_at) VALUES ('fp1', 'a-v1', '[]', ${Date.now()})`,
      );
      expect(repository.find("fp1", "a-v1", MODEL_A, HASH_A)).toBeNull();
    });
  });

  describe("model (docs/audit AC-007, PR-017)", () => {
    it("treats a mismatched model as a cache miss, even with the same fingerprint/promptVersion/contentHash", () => {
      repository.upsert("fp1", "a-v1", MODEL_A, HASH_A, record(), new Date());
      expect(repository.find("fp1", "a-v1", MODEL_B, HASH_A)).toBeNull();
    });

    it("keeps both models' extractions independently retrievable under the same fingerprint/promptVersion/contentHash (docs/audit PR-017)", () => {
      // The exact bug PR-017 names: alternating LLM_MODEL between two
      // calibration runs used to evict the other model's still-valid
      // extraction on every switch, because the row's actual database
      // identity did not include `model`.
      repository.upsert(
        "fp1",
        "a-v1",
        MODEL_A,
        HASH_A,
        record({ requirements: [] }),
        new Date(),
      );
      repository.upsert(
        "fp1",
        "a-v1",
        MODEL_B,
        HASH_A,
        record({ seniority: "trainee" }),
        new Date(),
      );

      expect(
        repository.find("fp1", "a-v1", MODEL_A, HASH_A)?.requirements,
      ).toEqual([]);
      expect(repository.find("fp1", "a-v1", MODEL_B, HASH_A)?.seniority).toBe(
        "trainee",
      );
    });

    it("treats a legacy row with no stored model as a miss", () => {
      db.run(
        sql`INSERT INTO extractions (fingerprint, prompt_version, requirements, content_hash, extracted_at) VALUES ('fp1', 'a-v1', '[]', ${HASH_A}, ${Date.now()})`,
      );
      expect(repository.find("fp1", "a-v1", MODEL_A, HASH_A)).toBeNull();
    });
  });

  describe("corrupted cache rows (docs/audit AC-031, PR-013)", () => {
    it("find treats truncated JSON as a cache miss instead of throwing", () => {
      repository.upsert("fp1", "a-v1", MODEL_A, HASH_A, record(), new Date());
      // A real restore/manual-edit scenario, not a mock -- write truncated
      // JSON directly into the column, bypassing upsert's own JSON.stringify.
      db.run(
        sql`UPDATE extractions SET requirements = '{"text": "truncated' WHERE fingerprint = 'fp1'`,
      );

      expect(() =>
        repository.find("fp1", "a-v1", MODEL_A, HASH_A),
      ).not.toThrow();
      expect(repository.find("fp1", "a-v1", MODEL_A, HASH_A)).toBeNull();
    });

    it("find treats valid JSON that is not an array as a cache miss", () => {
      repository.upsert("fp1", "a-v1", MODEL_A, HASH_A, record(), new Date());
      db.run(
        sql`UPDATE extractions SET requirements = '{"not": "an array"}' WHERE fingerprint = 'fp1'`,
      );

      expect(repository.find("fp1", "a-v1", MODEL_A, HASH_A)).toBeNull();
    });

    it("find treats a structurally-valid-JSON array of domain-invalid elements as a cache miss", () => {
      // The exact gap PR-013 names: [{}], [null], and an invalid enum are
      // all valid JSON and all real arrays -- Array.isArray alone accepted
      // every one of them as if they were real Requirement[].
      repository.upsert("fp1", "a-v1", MODEL_A, HASH_A, record(), new Date());
      db.run(
        sql`UPDATE extractions SET requirements = '[{}]' WHERE fingerprint = 'fp1'`,
      );
      expect(repository.find("fp1", "a-v1", MODEL_A, HASH_A)).toBeNull();
    });

    it("find rejects an invalid weight enum on an otherwise well-formed requirement", () => {
      repository.upsert("fp1", "a-v1", MODEL_A, HASH_A, record(), new Date());
      db.run(
        sql`UPDATE extractions SET requirements = '[{"text":"Node.js","category":"language","weight":"urgent"}]' WHERE fingerprint = 'fp1'`,
      );
      expect(repository.find("fp1", "a-v1", MODEL_A, HASH_A)).toBeNull();
    });

    it("find accepts a requirement omitting the optional verifiable field", () => {
      repository.upsert("fp1", "a-v1", MODEL_A, HASH_A, record(), new Date());
      db.run(
        sql`UPDATE extractions SET requirements = '[{"text":"Node.js","category":"language","weight":"mandatory"}]' WHERE fingerprint = 'fp1'`,
      );
      expect(
        repository.find("fp1", "a-v1", MODEL_A, HASH_A)?.requirements,
      ).toEqual([
        { text: "Node.js", category: "language", weight: "mandatory" },
      ]);
    });
  });
});
