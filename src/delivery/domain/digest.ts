import { Posting } from "../../posting/domain/posting";
import { Recommendation } from "../../scoring/domain/recommendation";
import { ScoreOutcome } from "../../scoring/domain/types";

/**
 * A scored posting is what every digest section is built from. `apply` and
 * `review` sections both hold the same shape — what differs is the verdict
 * inside `outcome`, and the caller (composeDigest) is what buckets them.
 *
 * `outcome` is `ScoreOutcome & Recommendation`, not `ScoreOutcome` alone
 * (docs/audit AC-026): every `ScoredPosting` is built from a `ScoreResult`
 * with `ok: true`, which `ScorerPort` already types as exactly that
 * intersection — `ApiScorer.score` spreads both `computeScore`'s and
 * `computeRecommendation`'s results into one object. The narrower type here
 * used to hide `recommendedVariant`/`highlights`/`missingTerms` from
 * anything reading `entry.outcome`, even though the fields were present on
 * the actual value at runtime the whole time — `render-digest.ts` simply
 * had no type-safe way to reach them.
 *
 * `ScoreResult` (`scorer.port.ts`) also carries `inputTruncated`
 * (docs/audit AC-017), deliberately NOT widened into this type: nothing
 * downstream of `ScoredPosting` renders it yet, and every digest test in
 * this codebase constructs `ScoreOutcome & Recommendation` fixtures
 * directly — widening this type for a field with no reader would only be
 * test churn. `executeDeliver` (`cli/main.ts`) still has `result` in scope
 * when it builds a `ScoredPosting`, so `result.inputTruncated` is one field
 * access away whenever something needs to read it.
 */
export interface ScoredPosting {
  readonly posting: Posting;
  readonly outcome: ScoreOutcome & Recommendation;
}

/**
 * A posting held back for not yet being reachable at your academic period.
 * `opensAtLabel` is a pre-formatted calendar term ("2027.1"), not the raw
 * period index.
 *
 * Still always empty post-M7 (docs/audit AC-026) — not because nothing can
 * read the requirement text anymore (Stage A does extract a "cursando a
 * partir do Nº período" requirement, and Stage B matches it, same as any
 * other), but because nothing turns that specific requirement into a
 * *structured* minimum period this system could compare against
 * `computeAcademicPeriod` and use to compute an "opens at" date. Today a
 * period requirement the candidate does not yet meet is scored like any
 * other unmet requirement (often `blocking`, capping the score) — the
 * *separate*, non-punitive "opens for you in 2027.1" section this comment
 * describes was never built. `executeDeliver` always passes `[]` here.
 */
export interface PeriodBlockedEntry {
  readonly posting: Posting;
  readonly opensAtLabel: string;
}

export interface RunSummary {
  readonly collected: number;
  readonly deduplicated: number;
  readonly filtered: number;
  readonly scored: number;
  readonly failedSources: readonly string[];
}

/**
 * The real digest shape (docs/02-architecture.md), replacing the M1
 * placeholder. Sections mirror the four listed there: recommended, review,
 * period-blocked, and a run summary that keeps principle 1 honest — a failed
 * source is visible in the digest, not silently absent.
 */
export interface Digest {
  readonly runId: string;
  readonly generatedAt: Date;
  readonly recommended: readonly ScoredPosting[];
  readonly review: readonly ScoredPosting[];
  readonly periodBlocked: readonly PeriodBlockedEntry[];
  readonly summary: RunSummary;
}

export interface ComposeDigestInput {
  readonly runId: string;
  readonly generatedAt: Date;
  readonly scored: readonly ScoredPosting[];
  readonly periodBlocked: readonly PeriodBlockedEntry[];
  readonly summary: RunSummary;
}

/**
 * Buckets scored postings into `recommended` (`apply`) and `review`
 * (`review`) by their verdict. `discard` postings are dropped here — they are
 * still in the corpus (never deleted, ADR-007), just not in the digest.
 */
export function composeDigest(input: ComposeDigestInput): Digest {
  const recommended: ScoredPosting[] = [];
  const review: ScoredPosting[] = [];

  for (const entry of input.scored) {
    if (entry.outcome.verdict === "apply") recommended.push(entry);
    else if (entry.outcome.verdict === "review") review.push(entry);
  }

  return {
    runId: input.runId,
    generatedAt: input.generatedAt,
    recommended,
    review,
    periodBlocked: input.periodBlocked,
    summary: input.summary,
  };
}
