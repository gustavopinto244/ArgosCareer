import { htmlToText } from "./html-to-text";
import { hashExtractionInput } from "./extraction-input-hash";
import { truncateDescription } from "./text-truncation";

/**
 * The exact normalize-then-hash pipeline Stage A's cache key is built from
 * (docs/audit AC-006, AC-017) — a single function so a second reader can
 * ask "what would today's cache key be for this posting" without
 * duplicating the normalization steps and risking the two answers drifting
 * apart. Pulled out of `StageAExtractor.extract` (docs/audit PR-017):
 * `MarketRepository` (M10) needs the same `contentHash` to check a cached
 * extraction against the posting's *current* content before trusting it in
 * an aggregate read, and a copy of the steps that produce it is exactly
 * the kind of drift this project's cache-correctness findings (AC-006,
 * AC-007) keep tracing back to two places computing "the same" thing
 * slightly differently.
 */
export interface NormalizedPostingContent {
  readonly title: string;
  readonly description: string | null;
  readonly contentHash: string;
  /** True when either title or description had to be cut to its input bound. */
  readonly inputTruncated: boolean;
}

/** Titles are normally under 200 characters. This generous ceiling closes
 * the remaining unbounded Stage A input without affecting legitimate data. */
export const DEFAULT_MAX_TITLE_CHARS = 500;

export function normalizePostingContent(
  title: string,
  description: string | null,
  maxDescriptionChars: number,
  maxTitleChars: number = DEFAULT_MAX_TITLE_CHARS,
): NormalizedPostingContent {
  const boundedTitle = truncateDescription(
    htmlToText(title).text,
    maxTitleChars,
  );
  const normalizedTitle = boundedTitle.text;
  let normalizedDescription: string | null = null;
  let inputTruncated = boundedTitle.truncated;
  if (description) {
    const bounded = truncateDescription(
      htmlToText(description).text,
      maxDescriptionChars,
    );
    normalizedDescription = bounded.text;
    inputTruncated ||= bounded.truncated;
  }
  return {
    title: normalizedTitle,
    description: normalizedDescription,
    contentHash: hashExtractionInput(normalizedTitle, normalizedDescription),
    inputTruncated,
  };
}
