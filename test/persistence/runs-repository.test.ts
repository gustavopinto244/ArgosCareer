import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  runMigrations,
} from "../../src/persistence/infrastructure/db";
import { RunsRepository } from "../../src/persistence/infrastructure/runs-repository";

let dir: string;
let repository: RunsRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argos-runs-"));
  const db = createDatabase(join(dir, "argos.db"));
  runMigrations(db);
  repository = new RunsRepository(db);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("RunsRepository", () => {
  it("starts a run with no outcome and no finishedAt yet", () => {
    const runId = repository.start("collect", new Date("2026-08-14T03:00:00Z"));

    const row = repository.findById(runId);
    expect(row?.kind).toBe("collect");
    expect(row?.outcome).toBeNull();
    expect(row?.finishedAt).toBeNull();
  });

  it("generates a unique runId per start", () => {
    const first = repository.start("collect", new Date());
    const second = repository.start("collect", new Date());
    expect(first).not.toBe(second);
  });

  it("finish records the outcome, finishedAt and per-stage counts", () => {
    const runId = repository.start("collect", new Date("2026-08-14T03:00:00Z"));

    repository.finish(runId, new Date("2026-08-14T03:05:00Z"), "success", {
      collectedCount: 10,
      normalizedCount: 9,
      newCount: 7,
      alreadySeenCount: 2,
    });

    const row = repository.findById(runId);
    expect(row?.outcome).toBe("success");
    expect(row?.finishedAt).toEqual(new Date("2026-08-14T03:05:00Z"));
    expect(row?.collectedCount).toBe(10);
    expect(row?.normalizedCount).toBe(9);
    expect(row?.newCount).toBe(7);
    expect(row?.alreadySeenCount).toBe(2);
  });

  it("counts default to 0 when a run finishes without every count supplied", () => {
    const runId = repository.start("dedup", new Date());
    repository.finish(runId, new Date(), "success", { duplicateCount: 3 });

    const row = repository.findById(runId);
    expect(row?.duplicateCount).toBe(3);
    expect(row?.collectedCount).toBe(0);
  });

  it("records filtered, scored and delivered counts for a deliver run", () => {
    const runId = repository.start("deliver", new Date());
    repository.finish(runId, new Date(), "success", {
      filteredCount: 12,
      scoredCount: 12,
      deliveredCount: 5,
    });

    const row = repository.findById(runId);
    expect(row?.filteredCount).toBe(12);
    expect(row?.scoredCount).toBe(12);
    expect(row?.deliveredCount).toBe(5);
  });

  it("records a failed outcome", () => {
    const runId = repository.start("collect", new Date());
    repository.finish(runId, new Date(), "failed");

    expect(repository.findById(runId)?.outcome).toBe("failed");
  });
});
