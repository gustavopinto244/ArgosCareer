import { findSkills, Taxonomy } from "./taxonomy";
import {
  CorpusEntry,
  CountBucket,
  MarketAggregates,
  SkillFrequency,
} from "./types";

function countBy(
  entries: readonly CorpusEntry[],
  label: (entry: CorpusEntry) => string,
): CountBucket[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = label(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([bucketLabel, count]) => ({ label: bucketLabel, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Every distinct taxonomy skill mentioned anywhere in one posting's
 * requirements — deduplicated per posting so a skill named in three
 * separate requirements of the same posting still counts once, matching
 * "PostgreSQL appears in 58% of relevant postings" (docs/10-milestones.md),
 * a per-posting statement, not a per-mention one.
 */
export function skillsInPosting(
  entry: CorpusEntry,
  taxonomy: Taxonomy,
): string[] {
  const found = new Set<string>();
  for (const requirement of entry.requirements) {
    for (const skill of findSkills(
      `${requirement.text} ${requirement.category}`,
      taxonomy,
    )) {
      found.add(skill);
    }
  }
  return [...found];
}

/**
 * Stage C-style: pure, deterministic, no I/O (docs/04-scoring-model.md's
 * discipline, applied to market aggregation). Runs over the **whole**
 * corpus `MarketRepository` hands it, including postings the pre-filter
 * rejected (`docs/05-domain-model.md`'s "corpus is not a cache" principle)
 * — company/region/work-mode/experience-level counts use every posting,
 * since those fields exist independent of Stage A. Skill frequency can
 * only use postings with a cached extraction, so its percentage is of
 * `extractedCount`, not `corpusSize` — reporting it against the whole
 * corpus would understate every real number by however thin Stage A
 * coverage currently is, which is itself the M10 close-out's honest
 * finding, not something to hide inside a misleading denominator.
 */
export function aggregateCorpus(
  entries: readonly CorpusEntry[],
  taxonomy: Taxonomy,
): MarketAggregates {
  const extracted = entries.filter((entry) => entry.requirements.length > 0);

  const skillCounts = new Map<string, number>();
  for (const entry of extracted) {
    for (const skill of skillsInPosting(entry, taxonomy)) {
      skillCounts.set(skill, (skillCounts.get(skill) ?? 0) + 1);
    }
  }
  const skillFrequency: SkillFrequency[] = [...skillCounts.entries()]
    .map(([skill, count]) => ({
      skill,
      count,
      percentage: extracted.length === 0 ? 0 : count / extracted.length,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    corpusSize: entries.length,
    extractedCount: extracted.length,
    skillFrequency,
    companies: countBy(entries, (entry) => entry.posting.company),
    regions: countBy(entries, (entry) =>
      entry.posting.location.kind === "known"
        ? entry.posting.location.city
        : "unknown",
    ),
    workModes: countBy(entries, (entry) => entry.posting.workMode),
    experienceLevels: countBy(
      entries,
      (entry) => entry.posting.seniority ?? "unknown",
    ),
  };
}
