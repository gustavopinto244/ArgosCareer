import { z } from "zod";
import { keywordMatchesText } from "../../prefilter/domain/title-match";

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
 * canonical names with no duplicates.
 *
 * Matching is delegated to `keywordMatchesText` — the same whole-word
 * matcher the pre-filter's title rules and `classifyTrack` use, for the
 * same reason. The original implementation here matched multi-word
 * candidates as plain substrings, which is the third place in this codebase
 * that mistake appeared: the alias `REST API` normalizes to `rest api`,
 * which is a substring of "fo**rest api**ario", so a beekeeping internship
 * counted as REST experience in the market aggregates.
 *
 * Delegating also buys punctuation-insensitivity for free, which this
 * function previously lacked: `Node.js` now matches "NodeJS", and `CI/CD`
 * matches "CI/CD", without listing every spelling as an alias.
 *
 * A short single-word alias that is genuinely also an ordinary word (`Go`)
 * can still false-positive — a whole-word matcher cannot tell the language
 * apart from the verb. `config/taxonomy.yaml` is expected to be tuned as
 * gap analysis surfaces real cases, not to be perfect on day one.
 */
export function findSkills(text: string, taxonomy: Taxonomy): string[] {
  const found = new Set<string>();
  for (const entry of taxonomy.skills) {
    const matches = [entry.canonical, ...entry.aliases].some((candidate) =>
      keywordMatchesText(text, candidate),
    );
    if (matches) {
      found.add(entry.canonical);
    }
  }
  return [...found];
}
