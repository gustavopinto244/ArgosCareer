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

/**
 * Used when `criteria.yaml` says nothing. Eight is deliberately modest: the
 * bound exists to cut wall-clock, not to extract maximum throughput from a
 * shared API, and every unit of concurrency is one more prompt that may be
 * in flight before the cached prefix it wants has landed (ADR-022).
 */
export const DEFAULT_STAGE_B_CONCURRENCY = 8;

export type MatchingResult =
  | { readonly ok: true; readonly matches: readonly Match[] }
  | {
      readonly ok: false;
      readonly reason: "matching_failed";
      readonly attempts: number;
    };

/** One requirement's answer, or the attempt count that failed to produce it. */
type Answer =
  | { readonly ok: true; readonly match: Match }
  | { readonly ok: false; readonly attempts: number };

/**
 * Runs `task` over `items` with at most `limit` in flight, preserving input
 * order in the result. Stops handing out new work as soon as one task
 * reports failure — calls already in flight still settle, but the remaining
 * requirements are never asked, which is the sequential loop's behaviour
 * held onto rather than abandoned for concurrency's sake.
 */
async function runBounded(
  items: readonly Requirement[],
  limit: number,
  task: (item: Requirement) => Promise<Answer>,
): Promise<(Answer | undefined)[]> {
  const results: (Answer | undefined)[] = new Array<Answer | undefined>(
    items.length,
  );
  let cursor = 0;
  let stopped = false;

  async function worker(): Promise<void> {
    while (!stopped) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (!item) return;
      const answer = await task(item);
      results[index] = answer;
      if (!answer.ok) stopped = true;
    }
  }

  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

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
 *
 * Those calls run **concurrently**, bounded by `concurrency` (ADR-022). This
 * is the highest-volume stage in the pipeline — one call per requirement,
 * ~25 per posting — and issuing them sequentially measured at 213.8s for a
 * single posting, or ~18h across a 310-posting backlog. Nothing the model
 * sees changes: same prompt per requirement, same isolation between them,
 * same cache keys. Only the waiting overlaps.
 *
 * The first requirement is deliberately asked **alone**, before the rest.
 * ADR-013 restructured this prompt so the large `PROFILE_EVIDENCE` block is
 * a shared prefix every stage B call can hit in the provider's prompt cache
 * (measured at 71% of prompt tokens). A cold prefix launched N ways at once
 * would have all N miss it, trading the cost lever away for the latency one.
 * One warming call costs a few seconds and keeps both.
 */
export class StageBMatcher {
  constructor(
    private readonly ask: AskModel,
    private readonly matchesRepo: MatchesRepository,
    private readonly promptVersion: string = STAGE_B_PROMPT_VERSION,
    private readonly concurrency: number = DEFAULT_STAGE_B_CONCURRENCY,
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

    const askOne = async (requirement: Requirement): Promise<Answer> => {
      // Same disk read, same contract, as stage A — see `StageAExtractor`.
      let prompt: string;
      try {
        prompt = buildStageBPrompt(requirement, profile);
      } catch {
        return { ok: false, attempts: 0 };
      }

      const result = await parseModelOutputWithRetries(
        MatchOutputSchema,
        this.ask,
        prompt,
      );
      if (!result.ok) return { ok: false, attempts: result.attempts };

      return {
        ok: true,
        match: createMatch(
          requirement,
          result.data.status,
          result.data.evidence,
        ),
      };
    };

    const answers: (Answer | undefined)[] = [];
    const [first, ...rest] = requirements;

    // The warming call (see the class docblock): one cold prefix, paid once,
    // so the concurrent calls behind it hit the provider's cache instead of
    // all racing the same miss.
    if (first) answers.push(await askOne(first));
    if (answers[0]?.ok) {
      answers.push(...(await runBounded(rest, this.concurrency, askOne)));
    }

    const matches: Match[] = [];
    for (const answer of answers) {
      // `undefined` means the requirement was never asked, because an earlier
      // one failed and `runBounded` stopped handing out work.
      if (!answer) break;
      if (!answer.ok) {
        return {
          ok: false,
          reason: "matching_failed",
          attempts: answer.attempts,
        };
      }
      matches.push(answer.match);
    }

    // A stopped run leaves fewer answers than requirements. Caching that
    // would poison the key, which covers the full requirement set (ADR-007).
    if (matches.length !== requirements.length) {
      return { ok: false, reason: "matching_failed", attempts: 0 };
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
