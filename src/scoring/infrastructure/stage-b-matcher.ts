import { z } from "zod";
import { Profile } from "../../profile/domain/profile";
import { MatchesRepository } from "../../persistence/infrastructure/matches-repository";
import { createMatch, Match, Requirement } from "../domain/types";
import { AskModel, parseModelOutputWithRetries } from "./llm-output";
import { buildStageBPrompt, STAGE_B_PROMPT_VERSION } from "./prompts";

const MatchOutputSchema = z.object({
  status: z.enum(["met", "partial", "not_met"]),
  evidence: z.string().min(1).nullable(),
});

export type MatchingResult =
  | { readonly ok: true; readonly matches: readonly Match[] }
  | {
      readonly ok: false;
      readonly reason: "matching_failed";
      readonly attempts: number;
    };

/**
 * Stage B (docs/04-scoring-model.md): one model call per requirement,
 * cached whole by `(fingerprint, profileHash, promptVersion)` (ADR-007).
 * `evidence: null` is coerced to `not_met` by `createMatch` regardless of
 * what `status` the model returned — ADR-005's rule, enforced in code, not
 * merely requested in the prompt.
 *
 * A failure on any one requirement discards the whole call rather than
 * caching a partial result — the cache key covers the full requirement set,
 * so a partial entry would be indistinguishable from a complete one on the
 * next read.
 */
export class StageBMatcher {
  constructor(
    private readonly ask: AskModel,
    private readonly matchesRepo: MatchesRepository,
    private readonly promptVersion: string = STAGE_B_PROMPT_VERSION,
  ) {}

  async match(
    fingerprint: string,
    requirements: readonly Requirement[],
    profile: Profile,
    profileHash: string,
    now: () => Date = () => new Date(),
  ): Promise<MatchingResult> {
    const cached = this.matchesRepo.find(
      fingerprint,
      profileHash,
      this.promptVersion,
    );
    if (cached) return { ok: true, matches: cached };

    const matches: Match[] = [];
    for (const requirement of requirements) {
      const prompt = buildStageBPrompt(requirement, profile);
      const result = await parseModelOutputWithRetries(
        MatchOutputSchema,
        this.ask,
        prompt,
      );

      if (!result.ok) {
        return {
          ok: false,
          reason: "matching_failed",
          attempts: result.attempts,
        };
      }

      matches.push(
        createMatch(requirement, result.data.status, result.data.evidence),
      );
    }

    this.matchesRepo.upsert(
      fingerprint,
      profileHash,
      this.promptVersion,
      matches,
      now(),
    );
    return { ok: true, matches };
  }
}
