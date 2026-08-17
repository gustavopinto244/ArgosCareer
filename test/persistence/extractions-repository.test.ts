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

  it("upserting the same (fingerprint, promptVersion) key overwrites, not duplicates", () => {
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

    it("re-upserting under a new contentHash replaces the old row rather than duplicating it", () => {
      repository.upsert("fp1", "a-v1", MODEL_A, HASH_A, record(), new Date());
      repository.upsert(
        "fp1",
        "a-v1",
        MODEL_A,
        HASH_B,
        record({ requirements: [] }),
        new Date(),
      );

      // The old content hash no longer resolves -- the row now belongs to
      // the new content, matching a real posting whose description changed
      // after the first extraction (fingerprint stays identical by design).
      expect(repository.find("fp1", "a-v1", MODEL_A, HASH_A)).toBeNull();
      expect(
        repository.find("fp1", "a-v1", MODEL_A, HASH_B)?.requirements,
      ).toEqual([]);
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

  describe("model (docs/audit AC-007)", () => {
    it("treats a mismatched model as a cache miss, even with the same fingerprint/promptVersion/contentHash", () => {
      repository.upsert("fp1", "a-v1", MODEL_A, HASH_A, record(), new Date());
      expect(repository.find("fp1", "a-v1", MODEL_B, HASH_A)).toBeNull();
    });

    it("treats a legacy row with no stored model as a miss", () => {
      db.run(
        sql`INSERT INTO extractions (fingerprint, prompt_version, requirements, content_hash, extracted_at) VALUES ('fp1', 'a-v1', '[]', ${HASH_A}, ${Date.now()})`,
      );
      expect(repository.find("fp1", "a-v1", MODEL_A, HASH_A)).toBeNull();
    });
  });

  describe("findAllForPromptVersion", () => {
    it("returns every extraction under the given prompt version, with fingerprint", () => {
      repository.upsert("fp1", "a-v1", MODEL_A, HASH_A, record(), new Date());
      repository.upsert(
        "fp2",
        "a-v1",
        MODEL_A,
        HASH_A,
        record({ requirements: [] }),
        new Date(),
      );

      const all = repository.findAllForPromptVersion("a-v1");
      expect(all.map((r) => r.fingerprint).sort()).toEqual(["fp1", "fp2"]);
    });

    it("excludes extractions under a different prompt version", () => {
      repository.upsert("fp1", "a-v1", MODEL_A, HASH_A, record(), new Date());
      repository.upsert("fp2", "a-v2", MODEL_A, HASH_A, record(), new Date());

      const all = repository.findAllForPromptVersion("a-v1");
      expect(all.map((r) => r.fingerprint)).toEqual(["fp1"]);
    });

    it("returns an empty array when nothing is cached under that prompt version", () => {
      expect(repository.findAllForPromptVersion("a-v99")).toEqual([]);
    });
  });

  describe("corrupted cache rows (docs/audit AC-031)", () => {
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

    it("findAllForPromptVersion skips a corrupted row instead of failing the whole scan", () => {
      repository.upsert("fp1", "a-v1", MODEL_A, HASH_A, record(), new Date());
      repository.upsert("fp2", "a-v1", MODEL_A, HASH_A, record(), new Date());
      db.run(
        sql`UPDATE extractions SET requirements = 'not json at all' WHERE fingerprint = 'fp1'`,
      );

      expect(() => repository.findAllForPromptVersion("a-v1")).not.toThrow();
      const all = repository.findAllForPromptVersion("a-v1");
      expect(all.map((r) => r.fingerprint)).toEqual(["fp2"]);
    });
  });
});
