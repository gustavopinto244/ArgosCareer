import { Profile } from "../../profile/domain/profile";
import { skillsInPosting } from "./aggregate-corpus";
import { findSkills, Taxonomy } from "./taxonomy";
import { CorpusEntry, GapAnalysisEntry } from "./types";

/**
 * Every taxonomy skill the profile already claims, via a competency's name
 * or any of its aliases — the "what's already known" side of the gap
 * comparison (docs/01-vision-and-scope.md).
 */
function profileSkills(profile: Profile, taxonomy: Taxonomy): Set<string> {
  const covered = new Set<string>();
  for (const competency of profile.competencies) {
    const text = [competency.name, ...competency.aliases].join(" ");
    for (const skill of findSkills(text, taxonomy)) {
      covered.add(skill);
    }
  }
  return covered;
}

/**
 * "Skills frequent in high-compatibility postings and weak or absent in the
 * profile, ranked by frequency" (docs/10-milestones.md). High-compatibility
 * means verdict `review` or `apply` — `discard` is excluded, reusing the
 * verdict tiers `04-scoring-model.md` already defines rather than inventing
 * a separate cutoff. A posting with no verdict (Stage A/B never ran) cannot
 * be judged high-compatibility and is excluded, not assumed either way.
 *
 * Pure, no I/O — `verdict` is precomputed by the caller (`MarketRepository`,
 * the same way `ApiScorer` calls Stage C) so this stays a plain reduction
 * over already-known facts, same discipline as `aggregateCorpus`.
 */
export function gapAnalysis(
  entries: readonly CorpusEntry[],
  profile: Profile,
  taxonomy: Taxonomy,
): GapAnalysisEntry[] {
  const covered = profileSkills(profile, taxonomy);
  const highCompatibility = entries.filter(
    (entry) => entry.verdict === "review" || entry.verdict === "apply",
  );

  const counts = new Map<string, number>();
  for (const entry of highCompatibility) {
    for (const skill of skillsInPosting(entry, taxonomy)) {
      if (covered.has(skill)) continue;
      counts.set(skill, (counts.get(skill) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([skill, count]) => ({
      skill,
      count,
      percentage:
        highCompatibility.length === 0 ? 0 : count / highCompatibility.length,
    }))
    .sort((a, b) => b.count - a.count);
}
