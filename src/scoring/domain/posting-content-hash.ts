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
  /** True when `description` had to be cut to fit `maxDescriptionChars`
   * (docs/audit AC-017). */
  readonly inputTruncated: boolean;
}

export function normalizePostingContent(
  title: string,
  description: string | null,
  maxDescriptionChars: number,
): NormalizedPostingContent {
  const normalizedTitle = htmlToText(title).text;
  let normalizedDescription: string | null = null;
  let inputTruncated = false;
  if (description) {
    const bounded = truncateDescription(
      htmlToText(description).text,
      maxDescriptionChars,
    );
    normalizedDescription = bounded.text;
    inputTruncated = bounded.truncated;
  }
  return {
    title: normalizedTitle,
    description: normalizedDescription,
    contentHash: hashExtractionInput(normalizedTitle, normalizedDescription),
    inputTruncated,
  };
}
