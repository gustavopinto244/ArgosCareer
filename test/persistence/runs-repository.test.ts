import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  runMigrations,
} from "../../src/persistence/infrastructure/db";
import {
  RunsRepository,
  parseAttemptedSources,
  parseFailedSources,
  parseLlmOutcomeCounts,
  parseSourceQueryStats,
  parseTruncatedSources,
} from "../../src/persistence/infrastructure/runs-repository";

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

  it("attributes a run to a non-secret principal identifier", () => {
    const runId = repository.start(
      "collect",
      new Date(),
      "automation:0123456789ab",
    );

    expect(repository.findById(runId)?.triggeredBy).toBe(
      "automation:0123456789ab",
    );
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

  it("records receivedCount and schemaRejectedCount (docs/audit AC-012)", () => {
    const runId = repository.start("collect", new Date());
    repository.finish(runId, new Date(), "success", {
      receivedCount: 50,
      schemaRejectedCount: 3,
    });

    const row = repository.findById(runId);
    expect(row?.receivedCount).toBe(50);
    expect(row?.schemaRejectedCount).toBe(3);
  });

  it("leaves receivedCount/schemaRejectedCount null, not a false 0, when finish never supplies them (docs/audit PR-014)", () => {
    // Reversing this column's original .notNull().default(0): a run that
    // never sets these -- every external-ingest run today -- used to read
    // back as "0 received," indistinguishable from a source that genuinely
    // returned nothing.
    const runId = repository.start("collect", new Date());
    repository.finish(runId, new Date(), "success", { collectedCount: 2 });

    const row = repository.findById(runId);
    expect(row?.collectedCount).toBe(2);
    expect(row?.receivedCount).toBeNull();
    expect(row?.schemaRejectedCount).toBeNull();
  });

  it("serializes truncatedSources to JSON, read back via parseTruncatedSources (docs/audit AC-013)", () => {
    const runId = repository.start("collect", new Date());
    repository.finish(runId, new Date(), "success", {
      truncatedSources: ["gupy", "solides"],
    });

    const row = repository.findById(runId);
    expect(row).not.toBeNull();
    expect(parseTruncatedSources(row!)).toEqual(["gupy", "solides"]);
  });

  it("parseTruncatedSources returns an empty array when nothing was truncated", () => {
    const runId = repository.start("collect", new Date());
    repository.finish(runId, new Date(), "success", {});

    const row = repository.findById(runId);
    expect(row).not.toBeNull();
    expect(parseTruncatedSources(row!)).toEqual([]);
  });

  it("records tooOldCount, unnormalizableCount and failureReason (docs/11 B2)", () => {
    const runId = repository.start("collect", new Date());
    repository.finish(runId, new Date(), "failed", {
      tooOldCount: 4,
      unnormalizableCount: 2,
      failureReason: "Gupy responded 500",
    });

    const row = repository.findById(runId);
    expect(row?.tooOldCount).toBe(4);
    expect(row?.unnormalizableCount).toBe(2);
    expect(row?.failureReason).toBe("Gupy responded 500");
  });

  it("leaves failureReason null when not supplied, not the string 'null'", () => {
    const runId = repository.start("collect", new Date());
    repository.finish(runId, new Date(), "success", {});

    expect(repository.findById(runId)?.failureReason).toBeNull();
  });

  it("serializes failedSources to JSON, read back via parseFailedSources", () => {
    const runId = repository.start("collect", new Date());
    repository.finish(runId, new Date(), "failed", {
      failedSources: ["indeed", "catho"],
    });

    const row = repository.findById(runId);
    expect(row).not.toBeNull();
    expect(parseFailedSources(row!)).toEqual(["indeed", "catho"]);
  });

  it("parseFailedSources returns an empty array when nothing failed", () => {
    const runId = repository.start("collect", new Date());
    repository.finish(runId, new Date(), "success", {});

    const row = repository.findById(runId);
    expect(row).not.toBeNull();
    expect(parseFailedSources(row!)).toEqual([]);
  });

  it("parseFailedSources tolerates malformed JSON rather than throwing", () => {
    expect(parseFailedSources({ failedSources: "not json" })).toEqual([]);
  });

  it("serializes attemptedSources to JSON, read back via parseAttemptedSources (docs/audit PR-003)", () => {
    const runId = repository.start("collect", new Date());
    repository.finish(runId, new Date(), "success", {
      attemptedSources: ["gupy", "indeed"],
    });

    const row = repository.findById(runId);
    expect(row).not.toBeNull();
    expect(parseAttemptedSources(row!)).toEqual(["gupy", "indeed"]);
  });

  it("parseAttemptedSources returns an empty array when nothing was recorded", () => {
    const runId = repository.start("collect", new Date());
    repository.finish(runId, new Date(), "success", {});

    const row = repository.findById(runId);
    expect(row).not.toBeNull();
    expect(parseAttemptedSources(row!)).toEqual([]);
  });

  it("persists reconcilable per-query funnels and parses them defensively", () => {
    const runId = repository.start("collect", new Date());
    repository.finish(runId, new Date(), "success", {
      sourceQueryStats: [
        {
          source: "gupy",
          queryIndex: 0,
          received: 10,
          schemaRejected: 1,
          normalized: 8,
          persistedNew: 3,
        },
      ],
    });

    const row = repository.findById(runId);
    expect(row).not.toBeNull();
    expect(parseSourceQueryStats(row!)).toEqual([
      expect.objectContaining({ source: "gupy", persistedNew: 3 }),
    ]);
    expect(parseSourceQueryStats({ sourceQueryStats: "not json" })).toEqual([]);
  });

  it("persists LLM token and outcome accounting", () => {
    const runId = repository.start("scoreAndDeliver", new Date());
    repository.finish(runId, new Date(), "success", {
      llmAttempts: 4,
      llmAttemptsWithoutUsage: 1,
      llmPromptTokens: 100,
      llmCompletionTokens: 25,
      llmCachedPromptTokens: 60,
      llmBlockedByCircuit: 2,
      llmOutcomeCounts: { success: 2, timeout: 1, authError: 1 },
    });

    const row = repository.findById(runId);
    expect(row).toMatchObject({
      llmAttempts: 4,
      llmAttemptsWithoutUsage: 1,
      llmPromptTokens: 100,
      llmCompletionTokens: 25,
      llmCachedPromptTokens: 60,
      llmBlockedByCircuit: 2,
    });
    expect(parseLlmOutcomeCounts(row!)).toEqual({
      success: 2,
      timeout: 1,
      authError: 1,
    });
    expect(parseLlmOutcomeCounts({ llmOutcomeCounts: "[]" })).toEqual({});
  });
});

describe("RunsRepository.findLastSuccessfulSourceCollectAt (docs/audit PR-003)", () => {
  it("returns null when the source has never been attempted", () => {
    expect(repository.findLastSuccessfulSourceCollectAt("gupy")).toBeNull();
  });

  it("returns the finish time of the run in which the source succeeded", () => {
    const runId = repository.start("collect", new Date("2026-08-14T03:00:00Z"));
    repository.finish(runId, new Date("2026-08-14T03:05:00Z"), "success", {
      attemptedSources: ["gupy"],
      failedSources: [],
    });

    expect(repository.findLastSuccessfulSourceCollectAt("gupy")).toEqual(
      new Date("2026-08-14T03:05:00Z"),
    );
  });

  it("returns null for a source that was attempted but always failed", () => {
    const runId = repository.start("collect", new Date());
    repository.finish(runId, new Date(), "failed", {
      attemptedSources: ["solides"],
      failedSources: ["solides"],
    });

    expect(repository.findLastSuccessfulSourceCollectAt("solides")).toBeNull();
  });

  it("does not confuse a different source's success with this one's", () => {
    const runId = repository.start("collect", new Date());
    repository.finish(runId, new Date(), "success", {
      attemptedSources: ["gupy"],
      failedSources: [],
    });

    expect(repository.findLastSuccessfulSourceCollectAt("solides")).toBeNull();
  });

  it("finds the source's own last success even when the run that contains it is not the most recent overall (docs/audit PR-003's exact scenario)", () => {
    // Day 0: solides succeeds.
    const day0 = repository.start("collect", new Date("2026-08-10T03:00:00Z"));
    repository.finish(day0, new Date("2026-08-10T03:05:00Z"), "success", {
      attemptedSources: ["gupy", "solides"],
      failedSources: [],
    });

    // Days 1-3: gupy keeps succeeding (so the run's own outcome is
    // "success" every time), solides fails every time. The bug this
    // guards: findLatestFinished("collect", "success") would return one of
    // these runs and make solides look like it recovered days sooner than
    // it actually did.
    for (let day = 1; day <= 3; day++) {
      const runId = repository.start(
        "collect",
        new Date(`2026-08-1${day}T03:00:00Z`),
      );
      repository.finish(
        runId,
        new Date(`2026-08-1${day}T03:05:00Z`),
        "success",
        { attemptedSources: ["gupy", "solides"], failedSources: ["solides"] },
      );
    }

    expect(repository.findLastSuccessfulSourceCollectAt("gupy")).toEqual(
      new Date("2026-08-13T03:05:00Z"),
    );
    // solides's own last success is still day 0, four runs back.
    expect(repository.findLastSuccessfulSourceCollectAt("solides")).toEqual(
      new Date("2026-08-10T03:05:00Z"),
    );
  });

  it("ignores a still-in-progress run (finishedAt null)", () => {
    repository.start("collect", new Date());
    // Never finished -- must not be treated as a success.
    expect(repository.findLastSuccessfulSourceCollectAt("gupy")).toBeNull();
  });
});
