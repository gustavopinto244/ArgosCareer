import { Criteria } from "../../prefilter/domain/criteria";
import { ScoringConfig } from "../domain/types";

/** Reshapes the criteria file's scoring section into stage C's config shape
 * — shared by every ScorerPort adapter that calls computeScore. */
export function buildScoringConfig(criteria: Criteria): ScoringConfig {
  return {
    weights: criteria.scoring.weights,
    thresholds: criteria.scoring.thresholds,
    trackWeights: criteria.trackWeights,
    minExtractedRequirements: criteria.scoring.minExtractedRequirements,
    blockingCapScore: criteria.scoring.blockingCapScore,
  };
}
