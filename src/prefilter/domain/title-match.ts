const COMBINING_MARKS = /[\u0300-\u036f]/g;
const NON_ALPHANUMERIC = /[^\p{L}\p{N}]+/gu;

/**
 * Title-matching normalization, deliberately **not** `normalize` from
 * `posting/domain/fingerprint.ts`: that one strips punctuation without
 * inserting anything, so "Estagiário(a)" collapses to "estagiarioa" and
 * word boundaries stop existing. Here punctuation becomes a **space**,
 * which is what makes whole-word matching possible at all.
 *
 * The two cannot be merged. The fingerprint normalizer is frozen — changing
 * it rewrites every fingerprint already stored and silently re-notifies the
 * entire corpus (ADR-007) — and it wants the opposite behaviour anyway.
 */
export function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .replace(NON_ALPHANUMERIC, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whole-word (or whole-phrase) match against a posting title.
 *
 * Substring matching was the original implementation and was measurably
 * wrong: `titleBlocklist` carries the seniority markers "III" and "IV", and
 * "iv" is a substring of ordinary Portuguese words that appear constantly in
 * real internship titles — "nível", "universitário", "afirmativa",
 * "administrativo", "civil", "executivo". Measured against the real 380-
 * posting corpus it wrongly blocked 24 postings, 9 of them genuine
 * internships including "Estágio Nível Superior - TI - Segurança da
 * Informação". The same flaw ran in the other direction on `titleRequired`,
 * where "intern" matched "interna", "internos" and "International" and let
 * non-internships through into LLM budget.
 *
 * Padding both sides with a space turns `includes` into a word-boundary test
 * while still supporting multi-word terms ("tech lead") — no regex, no
 * tokenizer. Re-measured on the same corpus: 24 false blocks removed, **zero**
 * true blocks lost ("Analista III" still blocks, since there "III" is its own
 * word), and the three false accepts gone.
 *
 * The cost, accepted: a term only matches as written, so plural and inflected
 * forms must be listed explicitly in `config/criteria.yaml` ("estágio" no
 * longer matches "Estágios"). That is the right place for it — criteria are
 * data, and a plural added there is visible in `git log`, where a stemmer
 * buried in code would not be.
 */
export function titleMatchesAny(
  title: string,
  terms: readonly string[],
): boolean {
  const haystack = ` ${normalizeTitle(title)} `;
  return terms.some((term) => {
    const needle = normalizeTitle(term);
    return needle !== "" && haystack.includes(` ${needle} `);
  });
}
