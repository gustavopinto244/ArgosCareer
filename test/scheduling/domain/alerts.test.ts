import { describe, expect, it } from "vitest";
import { RunRow } from "../../../src/persistence/infrastructure/runs-repository";
import {
  evaluateCollectionHealth,
  evaluateDeliveryOutcome,
  evaluateMissedRuns,
  MissedRunConfig,
} from "../../../src/scheduling/domain/alerts";

function run(overrides: Partial<RunRow> = {}): RunRow {
  return {
    runId: "run-1",
    kind: "collect",
    startedAt: new Date("2026-08-15T10:00:00Z"),
    finishedAt: new Date("2026-08-15T10:01:00Z"),
    outcome: "success",
    collectedCount: 0,
    normalizedCount: 0,
    newCount: 0,
    alreadySeenCount: 0,
    duplicateCount: 0,
    filteredCount: 0,
    scoredCount: 0,
    deliveredCount: 0,
    tooOldCount: 0,
    unnormalizableCount: 0,
    receivedCount: 0,
    schemaRejectedCount: 0,
    failureReason: null,
    failedSources: null,
    truncatedSources: null,
    attemptedSources: null,
    llmAttempts: 0,
    llmCostUsd: 0,
    llmAttemptsWithoutUsage: 0,
    ...overrides,
  };
}

describe("evaluateCollectionHealth", () => {
  it("does not alert when fewer runs than the threshold exist yet", () => {
    const runs = [run({ collectedCount: 0 })];
    expect(evaluateCollectionHealth(runs, 2)).toEqual([]);
  });

  it("alerts on N consecutive empty (but successful) runs", () => {
    const runs = [
      run({ runId: "3", collectedCount: 0 }),
      run({ runId: "2", collectedCount: 0 }),
      run({ runId: "1", collectedCount: 5 }),
    ];
    const alerts = evaluateCollectionHealth(runs, 2);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.text).toContain(
      "2 consecutive collection runs found zero postings",
    );
  });

  it("does not alert on empty runs short of the threshold", () => {
    const runs = [
      run({ runId: "2", collectedCount: 0 }),
      run({ runId: "1", collectedCount: 5 }),
    ];
    expect(evaluateCollectionHealth(runs, 2)).toEqual([]);
  });

  it("alerts on N consecutive errored runs, independently of the empty check", () => {
    const runs = [
      run({ runId: "2", outcome: "failed", collectedCount: 0 }),
      run({ runId: "1", outcome: "failed", collectedCount: 0 }),
    ];
    const alerts = evaluateCollectionHealth(runs, 2);
    const texts = alerts.map((a) => a.text);
    expect(texts.some((t) => t.includes("errored"))).toBe(true);
    // A failed run's collectedCount is 0 but outcome isn't "success", so the
    // empty-run alert (which requires outcome === "success") must not also fire.
    expect(texts.some((t) => t.includes("found zero postings"))).toBe(false);
  });

  it("does not alert when the most recent run recovered", () => {
    const runs = [
      run({ runId: "3", collectedCount: 5 }),
      run({ runId: "2", collectedCount: 0 }),
      run({ runId: "1", collectedCount: 0 }),
    ];
    expect(evaluateCollectionHealth(runs, 2)).toEqual([]);
  });
});

describe("evaluateDeliveryOutcome", () => {
  it("alerts when the run itself failed", () => {
    const alerts = evaluateDeliveryOutcome(run({ outcome: "failed" }), 0.5);
    expect(alerts.some((a) => a.text.includes("Delivery failed"))).toBe(true);
  });

  it("does not alert on a successful run with no scoring failures", () => {
    const alerts = evaluateDeliveryOutcome(
      run({ filteredCount: 10, scoredCount: 10 }),
      0.5,
    );
    expect(alerts).toEqual([]);
  });

  it("alerts when the scoring failure rate meets the threshold", () => {
    const alerts = evaluateDeliveryOutcome(
      run({ filteredCount: 10, scoredCount: 4 }), // 60% failed
      0.5,
    );
    expect(alerts.some((a) => a.text.includes("60%"))).toBe(true);
  });

  it("does not alert when the scoring failure rate is below the threshold", () => {
    const alerts = evaluateDeliveryOutcome(
      run({ filteredCount: 10, scoredCount: 9 }), // 10% failed
      0.5,
    );
    expect(alerts).toEqual([]);
  });

  it("does not divide by zero when nothing passed the pre-filter", () => {
    const alerts = evaluateDeliveryOutcome(
      run({ filteredCount: 0, scoredCount: 0 }),
      0.5,
    );
    expect(alerts).toEqual([]);
  });

  it("can report both a failed run and a high failure rate together", () => {
    const alerts = evaluateDeliveryOutcome(
      run({ outcome: "failed", filteredCount: 10, scoredCount: 0 }),
      0.5,
    );
    expect(alerts).toHaveLength(2);
  });
});

describe("evaluateMissedRuns", () => {
  const config: MissedRunConfig = {
    scoreAndDeliver: { time: "03:00", timezone: "America/Sao_Paulo" },
    collection: { intervalHours: 4 },
  };

  it("does not alert before today's scheduled deliver time has passed", () => {
    // 01:00 America/Sao_Paulo = 04:00 UTC, before the 03:00 threshold.
    const now = new Date("2026-08-15T04:00:00Z");
    const lastDeliver = run({
      kind: "scoreAndDeliver",
      finishedAt: new Date("2026-08-14T06:00:00Z"),
    });
    const lastCollect = run({ finishedAt: now });
    const alerts = evaluateMissedRuns(now, lastDeliver, lastCollect, config);
    expect(alerts.some((a) => a.text.includes("no digest"))).toBe(false);
  });

  it("alerts on the first missed scoreAndDeliver run, after the scheduled time", () => {
    // 10:00 America/Sao_Paulo = 13:00 UTC, well past 03:00.
    const now = new Date("2026-08-15T13:00:00Z");
    const lastDeliver = run({
      kind: "scoreAndDeliver",
      finishedAt: new Date("2026-08-14T06:00:00Z"), // yesterday
    });
    const lastCollect = run({ finishedAt: now });
    const alerts = evaluateMissedRuns(now, lastDeliver, lastCollect, config);
    expect(alerts.some((a) => a.text.includes("no digest"))).toBe(true);
  });

  it("does not alert once today's deliver run has already succeeded", () => {
    const now = new Date("2026-08-15T13:00:00Z");
    // Finished today (2026-08-15 in America/Sao_Paulo, ~10:00 local).
    const lastDeliver = run({
      kind: "scoreAndDeliver",
      finishedAt: new Date("2026-08-15T09:00:00Z"),
    });
    const lastCollect = run({ finishedAt: now });
    const alerts = evaluateMissedRuns(now, lastDeliver, lastCollect, config);
    expect(alerts.some((a) => a.text.includes("no digest"))).toBe(false);
  });

  it("alerts when no scoreAndDeliver run has ever succeeded, past the scheduled time", () => {
    const now = new Date("2026-08-15T13:00:00Z");
    const lastCollect = run({ finishedAt: now });
    const alerts = evaluateMissedRuns(now, null, lastCollect, config);
    expect(alerts.some((a) => a.text.includes("no digest"))).toBe(true);
  });

  it("does not alert on a collection gap under two intervals", () => {
    const now = new Date("2026-08-15T13:00:00Z");
    const lastCollect = run({
      finishedAt: new Date("2026-08-15T11:00:00Z"), // 2h ago, < 8h threshold
    });
    const lastDeliver = run({
      kind: "scoreAndDeliver",
      finishedAt: new Date("2026-08-15T09:00:00Z"),
    });
    const alerts = evaluateMissedRuns(now, lastDeliver, lastCollect, config);
    expect(alerts.some((a) => a.text.includes("collection run"))).toBe(false);
  });

  it("alerts once the collection gap reaches two intervals (self-heals otherwise)", () => {
    const now = new Date("2026-08-15T13:00:00Z");
    const lastCollect = run({
      finishedAt: new Date("2026-08-15T04:00:00Z"), // 9h ago, > 8h threshold
    });
    const lastDeliver = run({
      kind: "scoreAndDeliver",
      finishedAt: new Date("2026-08-15T09:00:00Z"),
    });
    const alerts = evaluateMissedRuns(now, lastDeliver, lastCollect, config);
    expect(alerts.some((a) => a.text.includes("collection run"))).toBe(true);
  });

  it("alerts when no collection run has ever succeeded", () => {
    const now = new Date("2026-08-15T13:00:00Z");
    const lastDeliver = run({
      kind: "scoreAndDeliver",
      finishedAt: new Date("2026-08-15T09:00:00Z"),
    });
    const alerts = evaluateMissedRuns(now, lastDeliver, null, config);
    expect(alerts.some((a) => a.text.includes("collection run"))).toBe(true);
  });
});
