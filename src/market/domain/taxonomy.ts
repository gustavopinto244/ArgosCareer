import { z } from "zod";
import { normalize } from "../../posting/domain/fingerprint";

export const TaxonomyEntrySchema = z.object({
  canonical: z.string().min(1),
  aliases: z.array(z.string().min(1)).default([]),
});

/**
 * `config/taxonomy.yaml`'s shape. Global and independent of
 * `config/profile.yaml`'s competency aliases on purpose
 * (`docs/01-vision-and-scope.md`): the profile only names what is already
 * known, so deriving aliases from it would only ever measure the
 * candidate's own vocabulary back at them.
 */
export const TaxonomySchema = z.object({
  skills: z.array(TaxonomyEntrySchema).min(1),
});

export type TaxonomyEntry = z.infer<typeof TaxonomyEntrySchema>;
export type Taxonomy = z.infer<typeof TaxonomySchema>;

/**
 * Finds every taxonomy skill mentioned in free text (a Stage A
 * requirement's `text`/`category`, typically a full sentence), returning
 * canonical names with no duplicates. A candidate matches as a whole word
 * when it is a single token (so the alias `Go` matches "Go" but not
 * "algorithm"), or as a substring when it is a multi-word phrase (so
 * "unit testing" matches inside a longer sentence without needing exact
 * token boundaries on both sides).
 *
 * A short single-word alias that is also an ordinary word (`Go`, `R`) can
 * still false-positive on a whole-word match — a known, accepted limitation
 * of a token-based matcher rather than a full NLP pipeline for a personal
 * project's corpus. `config/taxonomy.yaml` is expected to be tuned as gap
 * analysis surfaces real false positives, not perfect on day one.
 */
export function findSkills(text: string, taxonomy: Taxonomy): string[] {
  const normalizedText = normalize(text);
  if (normalizedText === "") {
    return [];
  }
  const words = new Set(normalizedText.split(" "));

  const found = new Set<string>();
  for (const entry of taxonomy.skills) {
    const candidates = [entry.canonical, ...entry.aliases];
    const matches = candidates.some((candidate) => {
      const normalizedCandidate = normalize(candidate);
      if (normalizedCandidate === "") return false;
      return normalizedCandidate.includes(" ")
        ? normalizedText.includes(normalizedCandidate)
        : words.has(normalizedCandidate);
    });
    if (matches) {
      found.add(entry.canonical);
    }
  }
  return [...found];
}
