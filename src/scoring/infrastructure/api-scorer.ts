import { classifyTrack } from "../../prefilter/domain/classify-track";
import { Criteria } from "../../prefilter/domain/criteria";
import { Posting } from "../../posting/domain/posting";
import { computeScore } from "../domain/score";
import { ScorerPort, ScoreResult } from "../domain/ports/scorer.port";
import { StageAExtractor } from "./stage-a-extractor";
import { StageBMatcher } from "./stage-b-matcher";
import { Profile } from "../../profile/domain/profile";
import { buildScoringConfig } from "./scoring-config";

/**
 * The calibration baseline (ADR-012, CLAUDE.md §14): stage A -> stage B ->
 * stage C, exactly the flow `docs/04-scoring-model.md` specifies, with a
 * hosted model behind `StageAExtractor`/`StageBMatcher` instead of the local
 * `OllamaScorer` this is a stepping stone toward. Track classification is
 * the same deterministic pre-filter function `StubScorer` uses — never an
 * LLM call, per principle 1 of `02-architecture.md`.
 *
 * A failure at either stage returns as a value, never throws — matching
 * `StubScorer` and every other port in this project.
 */
export class ApiScorer implements ScorerPort {
  constructor(
    private readonly extractor: StageAExtractor,
    private readonly matcher: StageBMatcher,
    private readonly profile: Profile,
    private readonly criteria: Criteria,
  ) {}

  async score(posting: Posting, profileHash: string): Promise<ScoreResult> {
    const tracks = classifyTrack(posting.title, this.criteria.tracks);

    const extraction = await this.extractor.extract(posting);
    if (!extraction.ok) {
      return {
        ok: false,
        reason: extraction.reason,
        attempts: extraction.attempts,
      };
    }

    const matching = await this.matcher.match(
      posting.fingerprint,
      extraction.requirements,
      this.profile,
      profileHash,
    );
    if (!matching.ok) {
      return {
        ok: false,
        reason: matching.reason,
        attempts: matching.attempts,
      };
    }

    const outcome = computeScore(
      matching.matches,
      tracks,
      buildScoringConfig(this.criteria),
    );
    return { ok: true, ...outcome };
  }
}
