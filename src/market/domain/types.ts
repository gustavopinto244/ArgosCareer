import { Match, Requirement, Verdict } from "../../scoring/domain/types";
import { Posting } from "../../posting/domain/posting";

/**
 * One posting's corpus record, assembled by `MarketRepository` from the
 * `postings`/`extractions`/`matches` tables. `requirements` is `[]` and
 * `matches`/`verdict` are `null` when Stage A/B never ran for this posting
 * (the common case today — the pre-filter passes very little of the real
 * corpus, docs/10-milestones.md's M9 close-out) rather than throwing: M10
 * aggregates over the whole corpus, including postings with no LLM data
 * at all.
 */
export interface CorpusEntry {
  readonly posting: Posting;
  readonly requirements: readonly Requirement[];
  readonly matches: readonly Match[] | null;
  readonly verdict: Verdict | null;
}

export interface SkillFrequency {
  readonly skill: string;
  readonly count: number;
  /** Of postings with at least one extraction — see `aggregate-corpus.ts`
   * for why this denominator, not the whole corpus. */
  readonly percentage: number;
}

export interface CountBucket {
  readonly label: string;
  readonly count: number;
}

export interface MarketAggregates {
  readonly corpusSize: number;
  readonly extractedCount: number;
  readonly skillFrequency: readonly SkillFrequency[];
  readonly companies: readonly CountBucket[];
  readonly regions: readonly CountBucket[];
  readonly workModes: readonly CountBucket[];
  readonly experienceLevels: readonly CountBucket[];
}

export interface GapAnalysisEntry {
  readonly skill: string;
  readonly count: number;
  /** Of high-compatibility postings — see `gap-analysis.ts`. */
  readonly percentage: number;
}

export interface TimeSeriesPoint {
  /** ISO date (Monday) of the week this bucket covers. */
  readonly weekStart: string;
  readonly count: number;
}
