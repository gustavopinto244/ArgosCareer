import { Posting } from "../../posting/domain/posting";
import { ScoreOutcome } from "../../scoring/domain/types";

/**
 * A scored posting is what every digest section is built from. `apply` and
 * `review` sections both hold the same shape — what differs is the verdict
 * inside `outcome`, and the caller (composeDigest) is what buckets them.
 */
export interface ScoredPosting {
  readonly posting: Posting;
  readonly outcome: ScoreOutcome;
}

/**
 * A posting held back for not yet being reachable at your academic period.
 * `opensAtLabel` is a pre-formatted calendar term ("2027.1"), not the raw
 * period index — nothing extracts a period requirement from posting text
 * until M7 gives stage A a description to read, so this list is expected to
 * be empty throughout M6. The section still exists and renders, because the
 * digest format is fixed now rather than retrofitted once M7 lands.
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
