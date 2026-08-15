import { describe, expect, it } from "vitest";
import {
  CalibrationEntry,
  computeCalibrationReport,
  pearsonCorrelation,
} from "../../../src/scoring/domain/calibration";
import { ScoringThresholds } from "../../../src/scoring/domain/types";

const THRESHOLDS: ScoringThresholds = { apply: 70, review: 45 };

function entry(overrides: Partial<CalibrationEntry> = {}): CalibrationEntry {
  return {
    fingerprint: "fp1",
    handScore: 80,
    computedScore: 80,
    computedVerdict: "apply",
    ...overrides,
  };
}

describe("pearsonCorrelation", () => {
  it("returns null for fewer than two pairs", () => {
    expect(pearsonCorrelation([])).toBeNull();
    expect(pearsonCorrelation([{ x: 1, y: 1 }])).toBeNull();
  });

  it("returns 1 for a perfect positive linear relationship", () => {
    const pairs = [
      { x: 0, y: 0 },
      { x: 50, y: 50 },
      { x: 100, y: 100 },
    ];
    expect(pearsonCorrelation(pairs)).toBeCloseTo(1, 10);
  });

  it("returns -1 for a perfect negative linear relationship", () => {
    const pairs = [
      { x: 0, y: 100 },
      { x: 50, y: 50 },
      { x: 100, y: 0 },
    ];
    expect(pearsonCorrelation(pairs)).toBeCloseTo(-1, 10);
  });

  it("returns null when the x series is constant — undefined, not zero", () => {
    const pairs = [
      { x: 50, y: 10 },
      { x: 50, y: 90 },
    ];
    expect(pearsonCorrelation(pairs)).toBeNull();
  });

  it("returns a value near zero for unrelated series", () => {
    const pairs = [
      { x: 0, y: 50 },
      { x: 100, y: 50 },
      { x: 50, y: 0 },
      { x: 50, y: 100 },
    ];
    expect(pearsonCorrelation(pairs)).toBeCloseTo(0, 5);
  });
});

describe("computeCalibrationReport — parse failures", () => {
  it("reports a zero failure rate when every posting scored", () => {
    const report = computeCalibrationReport(
      [entry(), entry({ fingerprint: "fp2" })],
      THRESHOLDS,
    );
    expect(report.n).toBe(2);
    expect(report.scored).toBe(2);
    expect(report.parseFailureRate).toBe(0);
  });

  it("counts a null computedScore as a parse failure, excluded from correlation", () => {
    const report = computeCalibrationReport(
      [
        entry(),
        entry({
          fingerprint: "fp2",
          computedScore: null,
          computedVerdict: null,
        }),
      ],
      THRESHOLDS,
    );
    expect(report.n).toBe(2);
    expect(report.scored).toBe(1);
    expect(report.parseFailureRate).toBe(0.5);
  });
});

describe("computeCalibrationReport — verdict precision/recall", () => {
  it("gives perfect precision and recall when computed matches hand exactly", () => {
    const entries: CalibrationEntry[] = [
      entry({
        fingerprint: "fp1",
        handScore: 90,
        computedScore: 90,
        computedVerdict: "apply",
      }),
      entry({
        fingerprint: "fp2",
        handScore: 50,
        computedScore: 50,
        computedVerdict: "review",
      }),
      entry({
        fingerprint: "fp3",
        handScore: 10,
        computedScore: 10,
        computedVerdict: "discard",
      }),
    ];
    const report = computeCalibrationReport(entries, THRESHOLDS);

    expect(report.verdictMetrics.apply).toEqual({
      support: 1,
      precision: 1,
      recall: 1,
    });
    expect(report.verdictMetrics.review).toEqual({
      support: 1,
      precision: 1,
      recall: 1,
    });
    expect(report.verdictMetrics.discard).toEqual({
      support: 1,
      precision: 1,
      recall: 1,
    });
  });

  it("scores a false negative on apply recall — a good posting the scorer missed", () => {
    // Hand says apply (90), the scorer under-scored it into review.
    const entries: CalibrationEntry[] = [
      entry({ handScore: 90, computedScore: 50, computedVerdict: "review" }),
    ];
    const report = computeCalibrationReport(entries, THRESHOLDS);

    expect(report.verdictMetrics.apply.support).toBe(1);
    expect(report.verdictMetrics.apply.recall).toBe(0);
    // Nothing was predicted "apply" at all, so precision is undefined.
    expect(report.verdictMetrics.apply.precision).toBeNull();
  });

  it("scores a false positive on apply precision — a bad posting the scorer over-scored", () => {
    // Hand says discard (10), the scorer wrongly scored it into apply.
    const entries: CalibrationEntry[] = [
      entry({ handScore: 10, computedScore: 90, computedVerdict: "apply" }),
    ];
    const report = computeCalibrationReport(entries, THRESHOLDS);

    expect(report.verdictMetrics.apply.precision).toBe(0);
    // Nothing hand-labeled resolves to "apply", so recall is undefined.
    expect(report.verdictMetrics.apply.recall).toBeNull();
    expect(report.verdictMetrics.discard.recall).toBe(0);
  });

  it("returns null precision and recall for a verdict with no support and no predictions", () => {
    const entries: CalibrationEntry[] = [
      entry({ handScore: 90, computedScore: 90, computedVerdict: "apply" }),
    ];
    const report = computeCalibrationReport(entries, THRESHOLDS);

    expect(report.verdictMetrics.discard).toEqual({
      support: 0,
      precision: null,
      recall: null,
    });
  });
});
