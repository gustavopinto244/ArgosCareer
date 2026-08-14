import { Posting } from "../../../posting/domain/posting";
import { ScoreOutcome } from "../types";

export type ScoreFailureReason =
  "invalid_output" | "extraction_failed" | "matching_failed";

/**
 * Bounded retries happen inside the adapter (ADR-006); by the time this
 * resolves, the outcome is final for this posting. `ok: false` is not an
 * exception — a posting that cannot be scored is not discarded, it carries
 * `attempts` into the digest's review section instead.
 */
export type ScoreResult =
  | ({ readonly ok: true } & ScoreOutcome)
  | {
      readonly ok: false;
      readonly reason: ScoreFailureReason;
      readonly attempts: number;
    };

/**
 * Stages A and B live behind this port. It never rejects — like
 * `CollectorPort`, failure is a value (docs/05-domain-model.md).
 */
export interface ScorerPort {
  score(posting: Posting, profileHash: string): Promise<ScoreResult>;
}
