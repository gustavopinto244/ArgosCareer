import {
  isVerifiable,
  Match,
  MatchStatus,
  Requirement,
  RequirementWeight,
  ScoreBreakdown,
  ScoreOutcome,
  ScoringConfig,
  Track,
  TrackWeights,
  Verdict,
} from "./types";

const STATUS_WEIGHT: Readonly<Record<MatchStatus, number>> = {
  met: 1.0,
  partial: 0.5,
  not_met: 0.0,
};

/**
 * Requirements a candidate could actually evidence (ADR-015). Everything
 * downstream — coverage, blocking failure, critical gaps, the low-confidence
 * count — reads this rather than the raw match list, so an unfalsifiable
 * trait is excluded from scoring in exactly one place.
 */
function verifiableMatches(matches: readonly Match[]): readonly Match[] {
  return matches.filter((m) => isVerifiable(m.requirement));
}

function coverage(
  matches: readonly Match[],
  weight: RequirementWeight,
): number {
  const inCategory = verifiableMatches(matches).filter(
    (m) => m.requirement.weight === weight,
  );
  if (inCategory.length === 0) return 1;
  const sum = inCategory.reduce(
    (total, m) => total + STATUS_WEIGHT[m.status],
    0,
  );
  return sum / inCategory.length;
}

/**
 * Highest weight wins on a multi-track posting (docs/04-scoring-model.md) —
 * averaging would penalize breadth, which is backwards for a posting that
 * genuinely spans two priority tracks.
 */
export function computeTrackAlignment(
  tracks: readonly Track[],
  trackWeights: TrackWeights,
): number {
  if (tracks.length === 0) return trackWeights.unknown;
  return Math.max(...tracks.map((track) => trackWeights[track]));
}

/**
 * A blocking requirement fails on `partial` too — an ATS knockout question is
 * binary, so "unsure" is not a pass (docs/04-scoring-model.md). Returns the
 * first failing blocking requirement, in match order.
 */
function findBlockingFailure(matches: readonly Match[]): Requirement | null {
  // Verifiable only (ADR-015): a trait extracted as `blocking` — "ter
  // compromisso e responsabilidade com as entregas" — would otherwise fail
  // for every candidate forever, capping every such posting at 35 on a
  // requirement no one can evidence.
  const failure = verifiableMatches(matches).find(
    (m) => m.requirement.weight === "blocking" && m.status !== "met",
  );
  return failure ? failure.requirement : null;
}

/** Exported for the M7 calibration protocol (docs/04-scoring-model.md),
 * which derives a "hand verdict" from a labeled score using the exact same
 * thresholds the real scorer uses — comparing them any other way would not
 * be measuring what production actually does. */
export function computeVerdict(
  score: number,
  thresholds: ScoringConfig["thresholds"],
): Verdict {
  if (score >= thresholds.apply) return "apply";
  if (score >= thresholds.review) return "review";
  return "discard";
}

/**
 * Mandatory or blocking requirements not fully met — a partial counts as a
 * gap too, since it still represents room to improve. Feeds the study-backlog
 * output described in docs/04-scoring-model.md.
 */
function computeCriticalGaps(matches: readonly Match[]): Requirement[] {
  // Verifiable only (ADR-015): this list feeds the study backlog, and
  // "be more proactive" is not something to go and learn.
  return verifiableMatches(matches)
    .filter(
      (m) =>
        (m.requirement.weight === "mandatory" ||
          m.requirement.weight === "blocking") &&
        m.status !== "met",
    )
    .map((m) => m.requirement);
}

/**
 * Stage C (ADR-005): pure, deterministic, no I/O, no LLM. Same inputs, same
 * output, forever — that is what makes the M7 calibration protocol meaningful.
 */
export function computeScore(
  matches: readonly Match[],
  tracks: readonly Track[],
  config: ScoringConfig,
): ScoreOutcome {
  const mandatoryCoverage = coverage(matches, "mandatory");
  const desirableCoverage = coverage(matches, "desirable");
  const trackAlignment = computeTrackAlignment(tracks, config.trackWeights);

  const breakdown: ScoreBreakdown = {
    mandatoryCoverage,
    desirableCoverage,
    trackAlignment,
  };

  const rawScore =
    config.weights.mandatory * mandatoryCoverage +
    config.weights.desirable * desirableCoverage +
    config.weights.trackAlignment * trackAlignment;

  const blockingFailure = findBlockingFailure(matches);
  // The cap is an upper bound, not a floor: a posting already scoring below
  // it is not raised (docs/04-scoring-model.md).
  const score = blockingFailure
    ? Math.min(rawScore, config.blockingCapScore)
    : rawScore;

  // Counts verifiable requirements, not all of them (ADR-015). Excluding
  // traits from coverage opens a hole this closes: a posting asking only for
  // "proatividade, dinamismo e boa comunicação" has every category empty,
  // takes coverage 1 from the empty-category rule, and would score near the
  // top while looking well-specified. Judged on what is actually checkable,
  // it is exactly the vague posting `docs/04`'s low-confidence rule is for.
  const lowConfidence =
    verifiableMatches(matches).length < config.minExtractedRequirements;

  let verdict = computeVerdict(score, config.thresholds);
  // lowConfidence caps the verdict at "review" — it never upgrades a "discard".
  if (lowConfidence && verdict === "apply") verdict = "review";

  return {
    score,
    verdict,
    breakdown,
    blockingFailure,
    lowConfidence,
    criticalGaps: computeCriticalGaps(matches),
  };
}
