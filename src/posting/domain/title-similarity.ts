/**
 * Words common enough in internship postings that they carry no
 * discriminating signal for "is this the same job" — without stripping
 * them, two genuinely different postings that both say "Estágio" score
 * higher than a real duplicate pair, because the shared boilerplate word
 * dominates the similarity measure. Small and Portuguese on purpose: this is
 * a heuristic over Gupy titles, not a general-purpose stopword list.
 */
const STOPWORDS = new Set([
  "estagio",
  "estagiario",
  "estagiaria",
  "trainee",
  "pessoa",
  "vaga",
  "de",
  "em",
  "para",
  "na",
  "no",
  "um",
  "uma",
  "e",
  "a",
  "o",
]);

/**
 * Lowercase, strip accents, turn punctuation into a space (not remove it) —
 * unlike `normalize` in fingerprint.ts, which strips punctuation without a
 * space and is why "Back-End" and "Back End" fingerprint differently on
 * purpose (that gap is what this module exists to catch). Similarity needs
 * "Back-End" and "Back End" to tokenize identically instead.
 */
function normalizeForSimilarity(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function significantTokens(title: string): string[] {
  return normalizeForSimilarity(title)
    .split(" ")
    .filter((token) => token && !STOPWORDS.has(token));
}

function bigrams(value: string): string[] {
  if (value.length < 2) return value ? [value] : [];
  const result: string[] = [];
  for (let i = 0; i < value.length - 1; i++) result.push(value.slice(i, i + 2));
  return result;
}

/**
 * Sørensen–Dice coefficient over character bigrams of the significant
 * (stopword-stripped, boilerplate-free) words, joined in sorted order so
 * word order does not matter — two posters phrasing the same role
 * differently ("Backend Estágio" vs "Estágio Backend") should still match.
 *
 * Character bigrams rather than whole-word tokens: word-level comparison
 * (Jaccard on tokens) scores the canonical layer-2 example from
 * docs/02-architecture.md — "Estágio em Back-end" vs "Estagiário Backend
 * (Rio de Janeiro)" — at 0.14, because "estágio" and "estagiário" are
 * different tokens even though they are the same word with a different
 * ending. Character bigrams give partial credit for that overlap.
 */
export function computeTitleSimilarity(a: string, b: string): number {
  const significantA = significantTokens(a).sort().join(" ");
  const significantB = significantTokens(b).sort().join(" ");

  if (significantA === "" && significantB === "") return 1;

  const bigramsA = bigrams(significantA);
  const bigramsB = bigrams(significantB);

  const countsB = new Map<string, number>();
  for (const bigram of bigramsB) {
    countsB.set(bigram, (countsB.get(bigram) ?? 0) + 1);
  }

  let intersectionSize = 0;
  for (const bigram of bigramsA) {
    const remaining = countsB.get(bigram) ?? 0;
    if (remaining > 0) {
      intersectionSize += 1;
      countsB.set(bigram, remaining - 1);
    }
  }

  const denominator = bigramsA.length + bigramsB.length;
  return denominator === 0 ? 1 : (2 * intersectionSize) / denominator;
}
