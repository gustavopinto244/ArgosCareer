import { normalize } from "../../posting/domain/fingerprint";
import { Posting } from "../../posting/domain/posting";
import { Track } from "../../scoring/domain/types";
import { classifyTrack } from "./classify-track";
import { Criteria } from "./criteria";
import { titleMatchesAny } from "./title-match";

export type PreFilterRejectionReason =
  | "title_blocked"
  | "title_missing_required_term"
  | "company_blocked"
  | "expired"
  | "location_not_allowed"
  | "insufficient_keyword_adherence";

/**
 * `tracks` is always populated, pass or fail — classification is cheap,
 * independent metadata worth keeping even on a rejected posting (useful for
 * M10's market analysis, which reads the whole corpus, not the shortlist).
 */
export interface PreFilterOutcome {
  readonly passed: boolean;
  readonly reason: PreFilterRejectionReason | null;
  readonly tracks: readonly Track[];
}

function isCompanyBlocked(posting: Posting, criteria: Criteria): boolean {
  const normalizedCompany = normalize(posting.company);
  return criteria.blockedCompanies.some(
    (company) => normalize(company) === normalizedCompany,
  );
}

/** `null` (no stated deadline) is unknown, not expired — absence is not
 * evidence a posting has closed. */
function isExpired(posting: Posting, now: Date): boolean {
  if (posting.applicationDeadline === null) return false;
  return posting.applicationDeadline.getTime() < now.getTime();
}

/**
 * Rio de Janeiro metro, or remote (CLAUDE.md §6). Rejects only when **both**
 * axes are definitively known-bad — `workMode` known and not remote, **and**
 * `location` known and not in the configured cities. Either axis being
 * `unknown` passes rather than silently discarding or accepting (M5): an
 * unknown `workMode` cannot be ruled out as remote, and an unknown location
 * cannot be ruled out as being in the target region.
 */
function isLocationAllowed(posting: Posting, criteria: Criteria): boolean {
  if (posting.workMode === "remote") return criteria.location.allowRemote;
  if (posting.workMode === "unknown") return true;
  if (posting.location.kind === "unknown") return true;

  const normalizedCity = normalize(posting.location.city);
  return criteria.location.cities.some(
    (city) => normalize(city) === normalizedCity,
  );
}

/**
 * Deliberately still substring-matched against the *fingerprint* normalizer,
 * unlike the title blocklist/required rules above. Profile keywords carry
 * the same punctuation variants the track keywords do — "Node.js",
 * "back-end", "CI/CD" — and whole-word matching would need every spelling
 * listed. None of them is a short token that collides with an ordinary
 * Portuguese word, which is the specific failure that forced the title
 * rules to change, so the tradeoff lands the other way here.
 */
function hasMinKeywordAdherence(
  normalizedTitle: string,
  profileKeywords: readonly string[],
  floor: number,
): boolean {
  if (floor <= 0) return true;
  const matched = profileKeywords.filter((keyword) =>
    normalizedTitle.includes(normalize(keyword)),
  ).length;
  return matched >= floor;
}

/**
 * Deterministic rules, run before any LLM call (docs/02-architecture.md).
 * Short-circuits at the first failing rule — every rejection records exactly
 * one reason. Rule order runs cheapest and most decisive first: two string
 * checks, then two single-field checks, then location (which reads two
 * fields), then keyword adherence (which scans the whole profile keyword
 * list) last, since it is the most expensive check and the least likely to
 * matter once everything before it has already run.
 */
export function applyPreFilter(
  posting: Posting,
  criteria: Criteria,
  profileKeywords: readonly string[],
  now: Date,
): PreFilterOutcome {
  const normalizedTitle = normalize(posting.title);
  const tracks = classifyTrack(
    posting.title,
    criteria.tracks,
    criteria.trackExclusions,
  );

  // Whole-word matching (`title-match.ts`), not substring: the blocklist's
  // "IV" was matching inside "nível", "universitário" and "afirmativa",
  // silently killing real internships.
  if (titleMatchesAny(posting.title, criteria.titleBlocklist)) {
    return { passed: false, reason: "title_blocked", tracks };
  }
  if (!titleMatchesAny(posting.title, criteria.titleRequired)) {
    return { passed: false, reason: "title_missing_required_term", tracks };
  }
  if (isCompanyBlocked(posting, criteria)) {
    return { passed: false, reason: "company_blocked", tracks };
  }
  if (isExpired(posting, now)) {
    return { passed: false, reason: "expired", tracks };
  }
  if (!isLocationAllowed(posting, criteria)) {
    return { passed: false, reason: "location_not_allowed", tracks };
  }
  if (
    !hasMinKeywordAdherence(
      normalizedTitle,
      profileKeywords,
      criteria.minKeywordAdherence,
    )
  ) {
    return { passed: false, reason: "insufficient_keyword_adherence", tracks };
  }

  return { passed: true, reason: null, tracks };
}
