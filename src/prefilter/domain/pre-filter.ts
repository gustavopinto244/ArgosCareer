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
  | "too_old"
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
 * Age, measured from `publishedAt` when the source states one and
 * `firstSeenAt` when it does not.
 *
 * The fallback is the whole point, and it is a deliberate departure from
 * ADR-011's leniency rule ("an unknown axis passes") — see Amendment 4.
 * Under that rule this
 * check would be inert exactly where it is most needed: 100% of CIEE's 2,079
 * active postings and 78% of Gupy's 558 carry no `publishedAt` at all
 * (measured 2026-08-16), so an age rule reading only that field would go on
 * paying to score an unbounded, permanently undated corpus.
 *
 * `firstSeenAt` is a weaker claim than `publishedAt` — it is when *this
 * system* first saw the posting, not when the company published it — and it
 * systematically *under*-estimates age, since a posting collected today may
 * have been open for months. That asymmetry is why the fallback is safe to
 * use here: it errs toward scoring a posting that should have been skipped,
 * never toward skipping a fresh one.
 *
 * The consequence worth knowing: a bulk import gives thousands of postings
 * the same `firstSeenAt`, so this rule does nothing for them until the window
 * passes and then drops them all at once. It is a bound on growth, not a
 * retroactive cleanup — `undatedBacklogCutoverAt` below is what makes it one.
 *
 * `undatedBacklogCutoverAt` (ADR-011 Amendment 5) is checked first and, when
 * it fires, short-circuits the `maxAgeDays` math entirely: an undated
 * posting first seen at or before the cutover is presumed already past the
 * limit, full stop, rather than having its real gap computed. That is a
 * deliberate business decision, not a measurement — see the schema comment
 * on `Criteria.undatedBacklogCutoverAt` for why `firstSeenAt` itself is never
 * rewritten to express it.
 */
function isTooOld(
  posting: Posting,
  maxAgeDays: number | null,
  undatedBacklogCutoverAt: Date | null,
  now: Date,
): boolean {
  if (maxAgeDays === null) return false;
  if (
    posting.publishedAt === null &&
    undatedBacklogCutoverAt !== null &&
    posting.firstSeenAt.getTime() <= undatedBacklogCutoverAt.getTime()
  ) {
    return true;
  }
  const reference = posting.publishedAt ?? posting.firstSeenAt;
  const ageMs = now.getTime() - reference.getTime();
  return ageMs > maxAgeDays * 24 * 60 * 60 * 1000;
}

/**
 * Rio de Janeiro metro, or remote (CLAUDE.md §6).
 *
 * Leniency is **asymmetric**, and ADR-011 Amendment 3 explains why the
 * original symmetric version had to change. An unknown *location* still
 * passes: the posting cannot be ruled out as being in the target region.
 * An unknown *work mode* no longer rescues a posting whose city is known
 * and outside it — absence of evidence about how the work happens does not
 * outweigh positive evidence about where it happens.
 *
 * The original rule was written when Gupy was the only source and usually
 * stated `workMode`. CIEE never states it, so under the symmetric rule
 * every São Paulo, Brasília and Fortaleza posting passed on the theory that
 * it "cannot be ruled out as remote" — 1,700 of them, measured.
 */
function isLocationAllowed(posting: Posting, criteria: Criteria): boolean {
  if (posting.workMode === "remote") return criteria.location.allowRemote;
  // An unknown location is still unknown, from any source.
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
 * checks, then three single-field checks (company, deadline, age), then
 * location (which reads two fields), then keyword adherence (which scans the
 * whole profile keyword list) last, since it is the most expensive check and
 * the least likely to matter once everything before it has already run.
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
  // After `expired`, before `location`: both are single-field date checks and
  // a closed posting is the more decisive rejection of the two.
  if (
    isTooOld(
      posting,
      criteria.maxAgeDays,
      criteria.undatedBacklogCutoverAt,
      now,
    )
  ) {
    return { passed: false, reason: "too_old", tracks };
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
