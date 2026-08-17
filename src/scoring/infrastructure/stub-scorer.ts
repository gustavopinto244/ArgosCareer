import { classifyTrack } from "../../prefilter/domain/classify-track";
import { Criteria } from "../../prefilter/domain/criteria";
import { Posting } from "../../posting/domain/posting";
import { computeScore } from "../domain/score";
import { EMPTY_RECOMMENDATION } from "../domain/recommendation";
import { ScorerPort, ScoreResult } from "../domain/ports/scorer.port";
import { buildScoringConfig } from "./scoring-config";

/**
 * `StubScorer` for M6's vertical slice: never calls an LLM, still runs the
 * real stage C. Track classification is real (`classifyTrack`, M5); the
 * match list is empty because stages A and B (extraction, matching) do not
 * exist until M7 — there is nothing to have extracted requirements from yet.
 *
 * That empty match list is not arbitrary: it exercises the empty-category
 * rule and `lowConfidence` exactly as documented (`docs/04-scoring-model.md`)
 * — every stub-scored posting gets full mandatory/desirable coverage from
 * having nothing to fail, `lowConfidence` true from having nothing extracted,
 * and a verdict capped at `review`. That is the honest ceiling for a scorer
 * that has not actually read the posting's requirements: never `apply`,
 * because nothing here constitutes an assessment, only a track-alignment
 * placeholder waiting for M7 to replace it with real matching.
 */
export class StubScorer implements ScorerPort {
  constructor(private readonly criteria: Criteria) {}

  async score(
    posting: Posting,
    _profileHash: string,
    _evaluatedAt?: Date,
  ): Promise<ScoreResult> {
    const tracks = classifyTrack(
      posting.title,
      this.criteria.tracks,
      this.criteria.trackExclusions,
    );
    const outcome = computeScore([], tracks, buildScoringConfig(this.criteria));

    return Promise.resolve({
      ok: true,
      ...outcome,
      ...EMPTY_RECOMMENDATION,
      // Never calls Stage A -- there is no input to have truncated.
      inputTruncated: false,
      stageACacheHit: false,
      stageBCacheHit: false,
      evidenceRejectedCount: 0,
    });
  }
}
