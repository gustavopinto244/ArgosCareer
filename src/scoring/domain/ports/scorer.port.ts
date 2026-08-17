import { Posting } from "../../../posting/domain/posting";
import { Recommendation } from "../recommendation";
import { ScoreFailureReason, ScoreOutcome } from "../types";

export type { ScoreFailureReason };

/**
 * Whether Stage A's input had to be cut to fit its size budget (docs/audit
 * AC-017) — kept as its own type rather than a field on `ScoreOutcome` for
 * the same reason `Recommendation` is separate: it is a fact about
 * *extraction*, not an output of `computeScore`'s formula, so adding it here
 * did not require touching that pure function or its tests.
 */
export interface ExtractionMetadata {
  readonly inputTruncated: boolean;
}

/**
 * Bounded retries happen inside the adapter (ADR-006); by the time this
 * resolves, the outcome is final for this posting. `ok: false` is not an
 * exception — a posting that cannot be scored is not discarded, it carries
 * `attempts` into the digest's review section instead.
 *
 * `Recommendation` (`recommendedVariant`/`highlights`/`missingTerms`) is
 * kept as a separate type from `ScoreOutcome` rather than folded into stage
 * C's formula output — it answers question 3 (`01-vision-and-scope.md`), a
 * different question from "what score does this posting get", computed by
 * a different pure function (`computeRecommendation`) over the same
 * matches. Keeping them separate means neither `computeScore` nor its tests
 * needed to change to add this.
 */
export type ScoreResult =
  | ({ readonly ok: true } & ScoreOutcome & Recommendation & ExtractionMetadata)
  | {
      readonly ok: false;
      readonly reason: ScoreFailureReason;
      readonly attempts: number;
      /**
       * True when the underlying cause was a permanent OpenRouter transport
       * failure — a revoked/invalid API key or an unsupported model
       * (docs/audit PR-007) — as opposed to a content-specific extraction
       * or matching failure local to this one posting. `executeDeliver`
       * reads this to stop scoring the rest of the batch immediately
       * rather than spending one doomed call per remaining posting on a
       * config problem no amount of per-posting retrying can fix.
       * `StubScorer` never sets it (it never calls a model at all).
       */
      readonly permanent: boolean;
    };

/**
 * Stages A and B live behind this port. It never rejects — like
 * `CollectorPort`, failure is a value (docs/05-domain-model.md).
 */
export interface ScorerPort {
  score(posting: Posting, profileHash: string): Promise<ScoreResult>;
}
