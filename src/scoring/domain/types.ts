/** weight ∈ {blocking, mandatory, desirable} (docs/04-scoring-model.md) */
export type RequirementWeight = "blocking" | "mandatory" | "desirable";

export type MatchStatus = "met" | "partial" | "not_met";

export interface Requirement {
  readonly text: string;
  readonly category: string;
  readonly weight: RequirementWeight;
  /**
   * Whether a candidate could demonstrate this with anything beyond their own
   * assertion (ADR-015). A personal trait — "proatividade", "dinamismo",
   * "trabalho em equipe" — is `false`: no portfolio can evidence it, stage B
   * can only answer `not_met`, and counting that as a failure measures
   * whether a CV contains the word rather than whether the candidate fits.
   *
   * Optional so requirements cached under `a-v2`, which predates the field,
   * still parse. Absent means verifiable: the conservative reading, since
   * excluding a requirement removes it from scoring entirely.
   */
  readonly verifiable?: boolean;
}

/** ADR-015: absent means verifiable, so legacy cached requirements keep
 * counting exactly as they did before the field existed. */
export function isVerifiable(requirement: Requirement): boolean {
  return requirement.verifiable !== false;
}

export interface Match {
  readonly requirement: Requirement;
  readonly status: MatchStatus;
  readonly evidence: string | null;
}

/**
 * `evidence: null` forces `not_met`, enforced once here rather than requested
 * of every caller — a `met` with no evidence is an invalid result regardless
 * of who produced it (ADR-005). Stage B (M7) is expected to construct every
 * `Match` through this factory.
 */
export function createMatch(
  requirement: Requirement,
  status: MatchStatus,
  evidence: string | null,
): Match {
  return {
    requirement,
    status: evidence === null ? "not_met" : status,
    evidence,
  };
}

export type Track = "dev" | "security" | "automation" | "unknown";

export type Verdict = "apply" | "review" | "discard";

export interface ScoringWeights {
  readonly mandatory: number;
  readonly desirable: number;
  readonly trackAlignment: number;
}

export interface ScoringThresholds {
  readonly apply: number;
  readonly review: number;
}

export interface TrackWeights {
  readonly dev: number;
  readonly security: number;
  readonly automation: number;
  readonly unknown: number;
}

export interface ScoringConfig {
  readonly weights: ScoringWeights;
  readonly thresholds: ScoringThresholds;
  readonly trackWeights: TrackWeights;
  /** Fewer extracted requirements than this triggers lowConfidence (docs/04). */
  readonly minExtractedRequirements: number;
  /** Score ceiling when a blocking requirement fails — 35 (docs/04). */
  readonly blockingCapScore: number;
  /** Score ceiling when the posting matches no configured track — ADR-025.
   * Distinct from `blockingCapScore`: this caps a *classification* outcome
   * (the posting is not the kind of role being searched for), not a
   * *requirement* failure, and the two stack via `Math.min` when both apply. */
  readonly unknownTrackCapScore: number;
}

export interface ScoreBreakdown {
  readonly mandatoryCoverage: number;
  readonly desirableCoverage: number;
  readonly trackAlignment: number;
}

/** Why `ScorerPort.score` returned `ok: false` — bounded retries already
 * exhausted by the time this is set (ADR-006). Lives here, not on
 * `ScorerPort` itself, so `ScoreOutcome` can reference it without a
 * circular import (`scorer.port.ts` already imports from this module). */
export type ScoreFailureReason =
  "invalid_output" | "extraction_failed" | "matching_failed";

export interface ScoreOutcome {
  readonly score: number;
  readonly verdict: Verdict;
  readonly breakdown: ScoreBreakdown;
  readonly blockingFailure: Requirement | null;
  readonly lowConfidence: boolean;
  readonly criticalGaps: readonly Requirement[];
  /**
   * Set only on the synthetic `ScoreOutcome` `executeDeliver` builds for a
   * posting that failed scoring entirely (docs/audit AC-009) — `null` or
   * absent for every real `computeScore` result. ADR-006 requires a failed
   * posting to appear in the digest's review section "with the reason
   * attached" rather than silently vanish; this is that reason, read by
   * `render-digest.ts`.
   */
  readonly scoreFailureReason?: ScoreFailureReason | null;
}

/**
 * A placeholder `ScoreOutcome` for a posting `ScorerPort.score` could not
 * score at all (docs/audit AC-009) — every real coverage/alignment term is
 * 0 because none was actually computed, `lowConfidence: true` for the same
 * reason a too-vague posting gets it (nothing to judge on), and `verdict:
 * "review"` so it lands in the same digest section a real low-confidence
 * posting would, per ADR-006's requirement that a scoring failure surface
 * to the user rather than disappear.
 */
export function scoreFailureOutcome(reason: ScoreFailureReason): ScoreOutcome {
  return {
    score: 0,
    verdict: "review",
    breakdown: {
      mandatoryCoverage: 0,
      desirableCoverage: 0,
      trackAlignment: 0,
    },
    blockingFailure: null,
    lowConfidence: true,
    criticalGaps: [],
    scoreFailureReason: reason,
  };
}
