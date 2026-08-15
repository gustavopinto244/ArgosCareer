import { computeVerdict } from "./score";
import { ScoringThresholds, Verdict } from "./types";

/**
 * One labeled posting run through the real scorer. `computedScore`/
 * `computedVerdict` are null when scoring failed (ADR-006) — a parse
 * failure is a calibration signal in its own right
 * (`docs/04-scoring-model.md`), not a data point to silently drop.
 */
export interface CalibrationEntry {
  readonly fingerprint: string;
  readonly handScore: number;
  readonly computedScore: number | null;
  readonly computedVerdict: Verdict | null;
}

export interface VerdictMetrics {
  /** How many labeled postings the hand score itself resolves to this
   * verdict, using the same thresholds the real scorer uses. */
  readonly support: number;
  /** True positives / predicted positives. Null when nothing was predicted
   * this verdict — precision is undefined, not zero, in that case. */
  readonly precision: number | null;
  /** True positives / actual positives. Null when no labeled posting
   * actually resolves to this verdict. */
  readonly recall: number | null;
}

export interface CalibrationReport {
  readonly n: number;
  readonly scored: number;
  readonly parseFailureRate: number;
  /** Null when fewer than 2 postings scored, or the hand scores (or the
   * computed scores) have zero variance — correlation is undefined there,
   * not zero. */
  readonly correlation: number | null;
  readonly verdictMetrics: Readonly<Record<Verdict, VerdictMetrics>>;
}

/**
 * Pearson product-moment correlation. Null rather than `NaN`/0 on an
 * undefined case (n < 2, or either series constant) — a calibration report
 * that silently prints 0 for "undefined" reads as "no correlation found"
 * instead of "not enough data to say".
 */
export function pearsonCorrelation(
  pairs: readonly { readonly x: number; readonly y: number }[],
): number | null {
  const n = pairs.length;
  if (n < 2) return null;

  const meanX = pairs.reduce((sum, p) => sum + p.x, 0) / n;
  const meanY = pairs.reduce((sum, p) => sum + p.y, 0) / n;

  let numerator = 0;
  let denomX = 0;
  let denomY = 0;
  for (const { x, y } of pairs) {
    const dx = x - meanX;
    const dy = y - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }

  if (denomX === 0 || denomY === 0) return null;
  return numerator / Math.sqrt(denomX * denomY);
}

const VERDICTS: readonly Verdict[] = ["apply", "review", "discard"];

/**
 * The calibration protocol's step 2 (`04-scoring-model.md`): correlation
 * between computed and hand-labelled scores, plus verdict precision/recall
 * per class — measured against the hand score run through the exact same
 * thresholds the real scorer uses, so "what should the verdict have been"
 * is defined identically to how production defines it.
 */
export function computeCalibrationReport(
  entries: readonly CalibrationEntry[],
  thresholds: ScoringThresholds,
): CalibrationReport {
  const n = entries.length;
  const scoredEntries = entries.filter(
    (e): e is CalibrationEntry & { computedScore: number } =>
      e.computedScore !== null,
  );
  const parseFailureRate = n === 0 ? 0 : (n - scoredEntries.length) / n;

  const correlation = pearsonCorrelation(
    scoredEntries.map((e) => ({ x: e.handScore, y: e.computedScore })),
  );

  const verdictMetrics: Record<Verdict, VerdictMetrics> = {} as Record<
    Verdict,
    VerdictMetrics
  >;
  for (const verdict of VERDICTS) {
    const actual = scoredEntries.filter(
      (e) => computeVerdict(e.handScore, thresholds) === verdict,
    );
    const predicted = scoredEntries.filter(
      (e) => e.computedVerdict === verdict,
    );
    const truePositives = scoredEntries.filter(
      (e) =>
        computeVerdict(e.handScore, thresholds) === verdict &&
        e.computedVerdict === verdict,
    );

    verdictMetrics[verdict] = {
      support: actual.length,
      precision:
        predicted.length === 0 ? null : truePositives.length / predicted.length,
      recall: actual.length === 0 ? null : truePositives.length / actual.length,
    };
  }

  return {
    n,
    scored: scoredEntries.length,
    parseFailureRate,
    correlation,
    verdictMetrics,
  };
}
