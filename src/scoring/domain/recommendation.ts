import { normalize } from "../../posting/domain/fingerprint";
import { deriveProfileKeywords } from "../../profile/domain/profile-keywords";
import { Profile } from "../../profile/domain/profile";
import { Match } from "./types";

/**
 * Question 3 of `01-vision-and-scope.md` — "how should I present my
 * profile for this posting?" — answered as three pure functions over
 * matches stage B already produced (`04-scoring-model.md`). No extra model
 * call, no generated text: the system selects and ranks material already in
 * the profile, which is what keeps the recommendation trustworthy.
 */
export interface Recommendation {
  readonly recommendedVariant: string | null;
  readonly highlights: readonly string[];
  readonly missingTerms: readonly string[];
}

export const EMPTY_RECOMMENDATION: Recommendation = {
  recommendedVariant: null,
  highlights: [],
  missingTerms: [],
};

/**
 * Reverse-looks-up which competency a match's evidence quote belongs to, by
 * exact string match against `profile.competencies[].evidence`. `Match`
 * itself carries only the quote, not which competency it came from — the
 * prompt tags evidence by competency for the model's benefit
 * (`prompts/stage-b-matching.v1.md`), not the domain type's.
 */
function matchedCompetencyNames(
  matches: readonly Match[],
  profile: Profile,
): ReadonlySet<string> {
  const evidenceToCompetency = new Map<string, string>();
  for (const competency of profile.competencies) {
    for (const evidence of competency.evidence) {
      evidenceToCompetency.set(evidence, competency.name);
    }
  }

  const names = new Set<string>();
  for (const match of matches) {
    if (match.status === "not_met" || match.evidence === null) continue;
    const name = evidenceToCompetency.get(match.evidence);
    if (name) names.add(name);
  }
  return names;
}

/**
 * The resume variant whose competencies overlap most with what this
 * posting's matches actually touched. Ties go to whichever variant appears
 * first in `profile.resumeVariants` — deterministic, since a strictly
 * greater overlap is required to replace the current best.
 */
function recommendVariant(
  matchedNames: ReadonlySet<string>,
  profile: Profile,
): string | null {
  if (matchedNames.size === 0) return null;

  let best: { id: string; overlap: number } | null = null;
  for (const variant of profile.resumeVariants) {
    const overlap = variant.competencyNames.filter((name) =>
      matchedNames.has(name),
    ).length;
    if (overlap > 0 && (!best || overlap > best.overlap)) {
      best = { id: variant.id, overlap };
    }
  }
  return best?.id ?? null;
}

/** Evidence from matches that scored `met` on a `mandatory` or `blocking`
 * requirement — deduplicated, since the same evidence line can support more
 * than one requirement. */
function computeHighlights(matches: readonly Match[]): string[] {
  const highlights = new Set<string>();
  for (const match of matches) {
    if (match.status !== "met") continue;
    if (match.requirement.weight === "desirable") continue;
    if (match.evidence) highlights.add(match.evidence);
  }
  return [...highlights];
}

/**
 * A requirement the profile satisfies (`met` or `partial`) but whose exact
 * wording appears nowhere in the profile's competency names or aliases —
 * "the posting says CI/CD, the profile says GitHub Actions" (04). A
 * keyword-matching ATS would miss it even though stage B correctly scored
 * it met; this is what resume tailoring reads before applying.
 */
function computeMissingTerms(
  matches: readonly Match[],
  profile: Profile,
): string[] {
  const normalizedKeywords = deriveProfileKeywords(profile).map(normalize);
  const missing: string[] = [];

  for (const match of matches) {
    if (match.status === "not_met") continue;
    const normalizedText = normalize(match.requirement.text);
    const alreadyNamed = normalizedKeywords.some((keyword) =>
      normalizedText.includes(keyword),
    );
    if (!alreadyNamed) missing.push(match.requirement.text);
  }
  return missing;
}

export function computeRecommendation(
  matches: readonly Match[],
  profile: Profile,
): Recommendation {
  return {
    recommendedVariant: recommendVariant(
      matchedCompetencyNames(matches, profile),
      profile,
    ),
    highlights: computeHighlights(matches),
    missingTerms: computeMissingTerms(matches, profile),
  };
}
