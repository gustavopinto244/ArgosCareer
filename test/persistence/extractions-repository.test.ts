import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  runMigrations,
} from "../../src/persistence/infrastructure/db";
import {
  ExtractionRecord,
  ExtractionsRepository,
} from "../../src/persistence/infrastructure/extractions-repository";

let dir: string;
let repository: ExtractionsRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argos-extractions-"));
  const db = createDatabase(join(dir, "argos.db"));
  runMigrations(db);
  repository = new ExtractionsRepository(db);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

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
    expect(repository.find("fp1", "a-v1")).toBeNull();
  });

  it("stores and retrieves a full extraction record for a (fingerprint, promptVersion) key", () => {
    repository.upsert("fp1", "a-v1", record(), new Date());
    expect(repository.find("fp1", "a-v1")).toEqual(record());
  });

  it("stores seniority and experienceYears alongside requirements", () => {
    repository.upsert(
      "fp1",
      "a-v1",
      record({ seniority: "internship", experienceYears: 0 }),
      new Date(),
    );
    const found = repository.find("fp1", "a-v1");
    expect(found?.seniority).toBe("internship");
    expect(found?.experienceYears).toBe(0);
  });

  it("keeps results for different prompt versions of the same posting independent", () => {
    repository.upsert("fp1", "a-v1", record(), new Date());
    repository.upsert("fp1", "a-v2", record({ requirements: [] }), new Date());

    expect(repository.find("fp1", "a-v1")).toEqual(record());
    expect(repository.find("fp1", "a-v2")?.requirements).toEqual([]);
  });

  it("upserting the same (fingerprint, promptVersion) key overwrites, not duplicates", () => {
    repository.upsert("fp1", "a-v1", record(), new Date());
    repository.upsert("fp1", "a-v1", record({ requirements: [] }), new Date());

    expect(repository.find("fp1", "a-v1")?.requirements).toEqual([]);
  });

  describe("findAllForPromptVersion", () => {
    it("returns every extraction under the given prompt version, with fingerprint", () => {
      repository.upsert("fp1", "a-v1", record(), new Date());
      repository.upsert(
        "fp2",
        "a-v1",
        record({ requirements: [] }),
        new Date(),
      );

      const all = repository.findAllForPromptVersion("a-v1");
      expect(all.map((r) => r.fingerprint).sort()).toEqual(["fp1", "fp2"]);
    });

    it("excludes extractions under a different prompt version", () => {
      repository.upsert("fp1", "a-v1", record(), new Date());
      repository.upsert("fp2", "a-v2", record(), new Date());

      const all = repository.findAllForPromptVersion("a-v1");
      expect(all.map((r) => r.fingerprint)).toEqual(["fp1"]);
    });

    it("returns an empty array when nothing is cached under that prompt version", () => {
      expect(repository.findAllForPromptVersion("a-v99")).toEqual([]);
    });
  });
});
