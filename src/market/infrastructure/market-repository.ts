import { classifyTrack } from "../../prefilter/domain/classify-track";
import { Criteria } from "../../prefilter/domain/criteria";
import { Db } from "../../persistence/infrastructure/db";
import { ExtractionsRepository } from "../../persistence/infrastructure/extractions-repository";
import { MatchesRepository } from "../../persistence/infrastructure/matches-repository";
import { PostingsRepository } from "../../persistence/infrastructure/postings-repository";
import {
  STAGE_A_PROMPT_VERSION,
  STAGE_B_PROMPT_VERSION,
} from "../../scoring/infrastructure/prompts";
import { buildScoringConfig } from "../../scoring/infrastructure/scoring-config";
import { computeScore } from "../../scoring/domain/score";
import { Match, Requirement } from "../../scoring/domain/types";
import { CorpusEntry } from "../domain/types";

/**
 * Assembles `CorpusEntry[]` from `postings` + `extractions` + `matches` —
 * the one I/O module M10's pure aggregation/gap-analysis functions run
 * over. Verdict recomputation here mirrors exactly what `ApiScorer` does
 * for a live scoring call (`classifyTrack` -> `computeScore`), just against
 * already-cached data instead of a fresh LLM call — the same Stage C
 * function, not a second implementation of "how do I score a posting."
 *
 * `findActive()` (not every row): a posting flagged as a similarity
 * duplicate (ADR-010) is the same real opening as its canonical sighting,
 * so counting it again would double-count one opening as two data points.
 * Pre-filter-rejected and `discard`-verdict postings are still included —
 * `findActive()` only excludes *duplicates*, not rejections
 * (`docs/05-domain-model.md`'s "corpus is not a cache").
 */
export class MarketRepository {
  constructor(
    private readonly db: Db,
    private readonly criteria: Criteria,
  ) {}

  loadCorpus(profileHash: string): CorpusEntry[] {
    const postings = new PostingsRepository(this.db).findActive();

    const extractionsByFingerprint = new Map<string, readonly Requirement[]>();
    for (const extraction of new ExtractionsRepository(
      this.db,
    ).findAllForPromptVersion(STAGE_A_PROMPT_VERSION)) {
      extractionsByFingerprint.set(
        extraction.fingerprint,
        extraction.requirements,
      );
    }

    const matchesByFingerprint = new Map<string, readonly Match[]>();
    for (const record of new MatchesRepository(this.db).findAllForProfile(
      profileHash,
      STAGE_B_PROMPT_VERSION,
    )) {
      matchesByFingerprint.set(record.fingerprint, record.matches);
    }

    const scoringConfig = buildScoringConfig(this.criteria);

    return postings.map((posting) => {
      const requirements =
        extractionsByFingerprint.get(posting.fingerprint) ?? [];
      const matches = matchesByFingerprint.get(posting.fingerprint) ?? null;

      const verdict = matches
        ? computeScore(
            matches,
            classifyTrack(
              posting.title,
              this.criteria.tracks,
              this.criteria.trackExclusions,
            ),
            scoringConfig,
          ).verdict
        : null;

      return { posting, requirements, matches, verdict };
    });
  }
}
