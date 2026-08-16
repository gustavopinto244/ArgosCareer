import { Db } from "../../persistence/infrastructure/db";
import { ExtractionsRepository } from "../../persistence/infrastructure/extractions-repository";
import { MatchesRepository } from "../../persistence/infrastructure/matches-repository";
import { PostingsRepository } from "../../persistence/infrastructure/postings-repository";
import { Criteria } from "../../prefilter/domain/criteria";
import { Profile } from "../../profile/domain/profile";
import { ScorerPort } from "../domain/ports/scorer.port";
import { ApiScorer } from "./api-scorer";
import { OpenRouterClient } from "./openrouter-client";
import { STAGE_B_PROMPT_VERSION, verifyPromptTemplates } from "./prompts";
import { StageAExtractor } from "./stage-a-extractor";
import { StageBMatcher } from "./stage-b-matcher";
import { StubScorer } from "./stub-scorer";

export type BuildScorerResult =
  | { readonly ok: true; readonly scorer: ScorerPort }
  | { readonly ok: false; readonly error: string };

/**
 * Reads `SCORER_ADAPTER` and builds the matching `ScorerPort` — the same
 * decision `deliverCommand` (`src/cli/main.ts`) made inline until M8, now
 * shared with the scheduler (`src/scheduling/infrastructure`) so both entry
 * points construct a scorer identically instead of two copies of this
 * switch quietly drifting apart. Returns a value rather than writing to
 * stderr/`process.exitCode` directly — the CLI and the unattended scheduler
 * report a misconfiguration differently (a console message vs. a Telegram
 * alert), so that choice stays with the caller.
 */
export function buildScorer(
  db: Db,
  criteria: Criteria,
  profile: Profile,
): BuildScorerResult {
  const adapter = process.env.SCORER_ADAPTER ?? "stub";

  if (adapter === "stub") {
    return { ok: true, scorer: new StubScorer(criteria) };
  }

  if (adapter === "api") {
    const apiKey = process.env.LLM_API_KEY;
    const model = process.env.LLM_MODEL;
    if (!apiKey || !model) {
      return {
        ok: false,
        error:
          "SCORER_ADAPTER=api requires LLM_API_KEY and LLM_MODEL (ADR-012)",
      };
    }
    // Before the first posting, not during it: the templates are read from
    // disk at scoring time, and on 2026-08-16 they were not in the container
    // image at all. Checked here so a packaging mistake is reported as a
    // misconfiguration, next to the missing-API-key case, rather than
    // throwing out of `ApiScorer.score` mid-batch.
    const promptError = verifyPromptTemplates();
    if (promptError) {
      return { ok: false, error: promptError };
    }

    const client = new OpenRouterClient({
      apiKey,
      model,
      ...(process.env.LLM_BASE_URL
        ? { baseUrl: process.env.LLM_BASE_URL }
        : {}),
    });
    const ask = client.complete.bind(client);
    return {
      ok: true,
      scorer: new ApiScorer(
        new StageAExtractor(ask, new ExtractionsRepository(db)),
        new StageBMatcher(
          ask,
          new MatchesRepository(db),
          STAGE_B_PROMPT_VERSION,
          criteria.scoring.stageBConcurrency,
        ),
        profile,
        criteria,
        new PostingsRepository(db),
      ),
    };
  }

  return {
    ok: false,
    error: `SCORER_ADAPTER=${adapter} is not implemented — "stub" and "api" are the only adapters (ADR-016)`,
  };
}
