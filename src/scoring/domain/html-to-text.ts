/**
 * Deterministic HTML-to-text conversion for a posting's description
 * (docs/audit AC-017). Sólides in particular returns real rich-text markup
 * (`h1`/`h2`/`p`/`strong`/`ul`/`li`) — sending it straight into a prompt
 * spends tokens on tag syntax the model gets no signal from, and, unbounded,
 * makes the input-size budget (`truncateDescription`) unpredictable: the
 * same visible text costs a different number of characters depending on how
 * verbose the source's markup happens to be.
 *
 * Not a general-purpose HTML parser — a small, deterministic pass tuned to
 * what job-posting rich text actually contains (headings, paragraphs, lists,
 * line breaks, bold/italic inline tags, entities). No third-party dependency:
 * this project already prefers a small hand-rolled pass over a library for
 * this kind of bounded transform (ADR-035's rejection of a retry library is
 * the same reasoning).
 */

const SCRIPT_OR_STYLE_BLOCK = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
const LIST_ITEM_OPEN = /<li\b[^>]*>/gi;
const LINE_BREAK = /<br\s*\/?>/gi;
/** Closing tags for elements that read as their own line/paragraph in plain
 * text — headings, paragraphs, list containers, table rows, blockquotes. */
const BLOCK_CLOSE = /<\/(p|div|h[1-6]|li|ul|ol|tr|table|blockquote)>/gi;
/**
 * Requires a letter or `/` immediately after `<` — the same condition
 * `HAS_MARKUP` uses to decide whether input contains markup at all. Without
 * this, plain text such as a salary comparison ("< R$ 2000 >") reads as an
 * opening+closing tag pair and both the delimiters and everything between
 * them are silently deleted, which is exactly the kind of invisible data
 * loss AC-017 exists to prevent.
 */
const ANY_TAG = /<\/?[a-zA-Z][^>]*>/g;
const HAS_MARKUP = /<[a-zA-Z/][^>]*>/;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const ENTITY_PATTERN = /&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g;

function decodeEntities(input: string): string {
  return input.replace(ENTITY_PATTERN, (match, code: string) => {
    if (code[0] === "#") {
      const isHex = code[1] === "x" || code[1] === "X";
      const codePoint = parseInt(
        isHex ? code.slice(2) : code.slice(1),
        isHex ? 16 : 10,
      );
      return Number.isFinite(codePoint)
        ? String.fromCodePoint(codePoint)
        : match;
    }
    return NAMED_ENTITIES[code] ?? match;
  });
}

export interface HtmlToTextResult {
  readonly text: string;
  /** True when the input actually contained markup this function stripped —
   * lets a caller record the reduction (AC-017's "registrando redução")
   * instead of it happening invisibly. False for input that was already
   * plain text, even if whitespace got collapsed. */
  readonly hadMarkup: boolean;
}

export function htmlToText(input: string): HtmlToTextResult {
  const hadMarkup = HAS_MARKUP.test(input);

  const withoutScripts = input.replace(SCRIPT_OR_STYLE_BLOCK, " ");
  const withLineBreaks = withoutScripts
    .replace(LIST_ITEM_OPEN, "\n- ")
    .replace(LINE_BREAK, "\n")
    .replace(BLOCK_CLOSE, "\n\n");
  const withoutTags = withLineBreaks.replace(ANY_TAG, "");
  const decoded = decodeEntities(withoutTags);

  const collapsed = decoded
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text: collapsed, hadMarkup };
}
