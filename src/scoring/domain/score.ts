import {
  computeAcademicPeriod,
  periodCalendarLabel,
} from "../../profile/domain/academic-period";
import { detectPeriodGate, PeriodGate } from "./period-gate";
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
 * binary, so "unsure" is not a pass (docs/04-scoring-model.md). Every failing
 * blocking requirement, in match order — `findBlockingFailure` below takes
 * just the first for existing single-value consumers.
 */
function findBlockingFailures(matches: readonly Match[]): Requirement[] {
  // Verifiable only (ADR-015): a trait extracted as `blocking` — "ter
  // compromisso e responsabilidade com as entregas" — would otherwise fail
  // for every candidate forever, capping every such posting at 35 on a
  // requirement no one can evidence.
  return verifiableMatches(matches)
    .filter((m) => m.requirement.weight === "blocking" && m.status !== "met")
    .map((m) => m.requirement);
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
 * `courseStart`/`today` are optional so every existing call site (35+ tests,
 * `StubScorer`, `market-repository.ts`'s historical re-scoring) keeps
 * computing exactly as before — periodGate detection needs a candidate's
 * calendar position, which those callers either don't have or don't need.
 * Only `ApiScorer.score`, which runs against a real profile and a real
 * clock, supplies it.
 */
export interface AcademicContext {
  readonly courseStart: Date;
  readonly today: Date;
}

/**
 * Stage C (ADR-005): pure, deterministic, no I/O, no LLM. Same inputs, same
 * output, forever — that is what makes the M7 calibration protocol meaningful.
 */
export function computeScore(
  matches: readonly Match[],
  tracks: readonly Track[],
  config: ScoringConfig,
  academicContext?: AcademicContext,
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

  const blockingFailures = findBlockingFailures(matches);
  const blockingFailure = blockingFailures[0] ?? null;
  // Both caps are upper bounds, not floors: a posting already scoring below
  // one is not raised by it (docs/04-scoring-model.md). They stack — a
  // blocked, off-track posting is capped by whichever is lower — because
  // they answer different questions: `blockingFailure` is about a specific
  // requirement, `tracks.length === 0` is about the posting's kind not
  // matching what is being searched for at all (ADR-025). Coverage alone
  // cannot be trusted to separate "the right kind of role, poorly matched"
  // from "the wrong kind of role, trivially satisfied" — a generic customer
  // service or HR posting has little to fail against, so mandatoryCoverage
  // routinely saturates near 1.0 for reasons that have nothing to do with
  // fit, and trackAlignment's 15% weight is not enough on its own to pull
  // that back down.
  let score = rawScore;
  if (blockingFailure) score = Math.min(score, config.blockingCapScore);
  if (tracks.length === 0) score = Math.min(score, config.unknownTrackCapScore);
  // A correctly-validated config (weights summing to 100, coverage/alignment
  // terms already bounded to [0, 1] by construction) can never produce a
  // score outside [0, 100] — this clamp is a second, independent guarantee
  // of the same invariant CriteriaSchema enforces at load time (docs/audit
  // AC-025), not a substitute for it: a config loaded from anywhere that
  // skips validation must still never hand a caller an out-of-range score.
  score = Math.min(100, Math.max(0, score));

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

  // Only when the period gate is the *entire* reason this posting is capped
  // (detectPeriodGate already requires it be the only blocking failure) and
  // the rest of the posting is worth surfacing at all — `rawScore`,
  // uncapped, cleared `review`. A posting that would not even clear review
  // ignoring the period gate is not "a good fit you're not eligible for
  // yet," it is a weak match that also has a period gate; staying an
  // ordinary capped `discard` is the correct outcome for that one.
  const periodGate: PeriodGate | null =
    academicContext && rawScore >= config.thresholds.review
      ? detectPeriodGate(
          blockingFailures,
          computeAcademicPeriod(
            academicContext.courseStart,
            academicContext.today,
          ),
          (minimumPeriod) =>
            periodCalendarLabel(academicContext.courseStart, minimumPeriod),
        )
      : null;

  return {
    score,
    verdict,
    breakdown,
    blockingFailure,
    blockingFailures,
    lowConfidence,
    criticalGaps: computeCriticalGaps(matches),
    periodGate,
  };
}
