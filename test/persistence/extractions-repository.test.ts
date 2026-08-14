import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  runMigrations,
} from "../../src/persistence/infrastructure/db";
import { ExtractionsRepository } from "../../src/persistence/infrastructure/extractions-repository";
import { Requirement } from "../../src/scoring/domain/types";

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

function requirements(): Requirement[] {
  return [
    { text: "Node.js experience", category: "language", weight: "mandatory" },
    { text: "SQL", category: "database", weight: "desirable" },
  ];
}

describe("ExtractionsRepository", () => {
  it("returns null for a fingerprint/promptVersion pair that was never stored", () => {
    expect(repository.find("fp1", "a-v1")).toBeNull();
  });

  it("stores and retrieves requirements for a (fingerprint, promptVersion) key", () => {
    repository.upsert("fp1", "a-v1", requirements(), new Date());
    expect(repository.find("fp1", "a-v1")).toEqual(requirements());
  });

  it("keeps results for different prompt versions of the same posting independent", () => {
    repository.upsert("fp1", "a-v1", requirements(), new Date());
    repository.upsert("fp1", "a-v2", [], new Date());

    expect(repository.find("fp1", "a-v1")).toEqual(requirements());
    expect(repository.find("fp1", "a-v2")).toEqual([]);
  });

  it("upserting the same (fingerprint, promptVersion) key overwrites, not duplicates", () => {
    repository.upsert("fp1", "a-v1", requirements(), new Date());
    repository.upsert("fp1", "a-v1", [], new Date());

    expect(repository.find("fp1", "a-v1")).toEqual([]);
  });
});
