/**
 * Bounds Stage A's input so a pathologically large posting description
 * cannot silently balloon prompt tokens, latency, or cost (docs/audit
 * AC-017 — "pior caso de tokens é limitado e mensurável"). Truncation is
 * flagged, never invisible: `truncated` on the result is what lets
 * `StageAExtractor.extract` report `inputTruncated` rather than the model
 * quietly seeing less than the real posting said.
 */

/**
 * `Intl.Segmenter`'s word granularity never splits inside a grapheme, so
 * accumulating whole segments up to the budget is both word-boundary-safe
 * and multibyte-safe (an emoji or an accented character can never be cut in
 * half) without hand-rolled surrogate-pair arithmetic.
 */
function truncateAtWordBoundary(text: string, maxChars: number): string {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  let result = "";
  for (const { segment } of segmenter.segment(text)) {
    if (result.length + segment.length > maxChars) break;
    result += segment;
  }
  return result.trimEnd();
}

export interface TruncationResult {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Section-aware: accumulates whole paragraphs (split on a blank line) up to
 * `maxChars` rather than cutting mid-paragraph or mid-requirement — a job
 * posting's requirements are usually one per line/paragraph, and cutting one
 * in half is worse than dropping it entirely. Falls back to a word-boundary
 * cut only when a single paragraph alone exceeds the whole budget.
 */
export function truncateDescription(
  text: string,
  maxChars: number,
): TruncationResult {
  if (text.length <= maxChars) return { text, truncated: false };

  const paragraphs = text.split(/\n{2,}/);
  let result = "";
  for (const paragraph of paragraphs) {
    const candidate = result ? `${result}\n\n${paragraph}` : paragraph;
    if (candidate.length > maxChars) break;
    result = candidate;
  }

  if (!result) {
    result = truncateAtWordBoundary(text, maxChars);
  }

  return { text: result, truncated: true };
}
