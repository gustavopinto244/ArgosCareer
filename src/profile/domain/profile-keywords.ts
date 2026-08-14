import { Profile } from "./profile";

/**
 * Every competency name and alias, flattened — the pre-filter's minimum
 * keyword adherence rule (M5) matches these against a posting's title.
 * Order is not meaningful; duplicates are harmless since the pre-filter only
 * checks presence.
 */
export function deriveProfileKeywords(profile: Profile): string[] {
  return profile.competencies.flatMap((competency) => [
    competency.name,
    ...competency.aliases,
  ]);
}
