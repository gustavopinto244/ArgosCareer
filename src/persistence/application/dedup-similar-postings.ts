import { normalize } from "../../posting/domain/fingerprint";
import { Posting } from "../../posting/domain/posting";
import { computeTitleSimilarity } from "../../posting/domain/title-similarity";
import { PostingsRepository } from "../infrastructure/postings-repository";

export interface DedupConfig {
  readonly similarityThreshold: number;
  readonly windowDays: number;
}

/**
 * Common Brazilian legal-entity suffixes, checked as the trailing token of
 * a normalized company name — never substring-matched, so a real word that
 * happens to contain one of these ("Casamentos Ltda" still keeps
 * "casamentos" whole) is untouched. Small and deliberately conservative,
 * same discipline as `title-similarity.ts`'s `STOPWORDS`: this is a
 * heuristic over real Brazilian company names, not a general-purpose
 * corporate-suffix list.
 */
const COMPANY_SUFFIXES = new Set(["sa", "ltda", "me", "eireli", "epp"]);

/**
 * Layer 2's grouping key — deliberately *not* `computeFingerprint`'s
 * `normalize(company)`, which is frozen under ADR-007 and must never
 * change. `"Empresa X"` (LinkedIn) and `"Empresa X S.A."` (Gupy) are the
 * same real company, formatted differently by two sources; grouping on the
 * exact normalized string meant they landed in different groups and were
 * never even title-compared by this function (docs/audit AC-014). Stripping
 * a trailing legal suffix here only widens which postings get *compared* —
 * `locationsAgree` and `computeTitleSimilarity` still decide whether they
 * actually merge, so this cannot turn two different companies into a false
 * merge on its own.
 */
function normalizeCompanyForGrouping(company: string): string {
  const tokens = normalize(company).split(" ").filter(Boolean);
  while (
    tokens.length > 1 &&
    COMPANY_SUFFIXES.has(tokens[tokens.length - 1]!)
  ) {
    tokens.pop();
  }
  return tokens.join(" ");
}

/** Provisional, like every threshold in this project until measured against
 * real data — see ADR-0010, and ADR-0010 Amendment 3 (docs/audit PR-006):
 * this threshold is exactly what shadow mode exists to gather real
 * measured false-positive/negative data against, not a value this project
 * currently trusts to act on unsupervised. */
export const DEFAULT_DEDUP_CONFIG: DedupConfig = {
  similarityThreshold: 0.35,
  windowDays: 14,
};

/**
 * One title-similarity match layer 2 found, in shadow mode (docs/audit
 * PR-006) — recorded for a human to review, never acted on automatically.
 * `canonical`/`candidate` name the pair the same way the old destructive
 * code did (earliest-seen first), but neither posting is touched: both stay
 * fully active, independently scoreable and deliverable.
 */
export interface ShadowDuplicateCandidate {
  readonly candidateFingerprint: string;
  readonly candidateTitle: string;
  readonly canonicalFingerprint: string;
  readonly canonicalTitle: string;
  readonly similarity: number;
}

export interface DedupOutcome {
  readonly scanned: number;
  /**
   * Always 0 (docs/audit PR-006) — layer 2 no longer calls `markDuplicate`
   * at all. Kept in the shape, not renamed or removed, so `runs.duplicateCount`
   * and `executeDeliver`'s `deduplicated` arithmetic stay meaningful rather
   * than needing a parallel "this number means something different now"
   * migration: it now honestly reports "how many postings layer 2
   * destructively removed," which is zero, because it destructively removes
   * none.
   */
  readonly markedDuplicate: number;
  /** Every match layer 2 found this pass, logged rather than acted on. See
   * `ShadowDuplicateCandidate`. */
  readonly shadowCandidates: readonly ShadowDuplicateCandidate[];
}

function withinWindow(a: Date, b: Date, windowDays: number): boolean {
  const diffMs = Math.abs(a.getTime() - b.getTime());
  return diffMs <= windowDays * 24 * 60 * 60 * 1000;
}

/**
 * Two postings can only be the same opening if their locations do not
 * contradict each other. Same company and a similar title is not enough:
 * a company hiring the same role in two cities is hiring twice.
 *
 * The conservative reading wins wherever the answer is unclear, the same
 * discipline shadow mode itself now applies one level up. Both cities known
 * and equal agrees; both unknown agrees (nothing contradicts); exactly one
 * known does **not**, because that is precisely the shape that ate a real
 * "Pessoa Desenvolvedora Backend Python" in Rio whose canonical had no city
 * at all (ADR-010 Amendment 1).
 *
 * docs/audit AC-014 names this same asymmetry as a cross-source false
 * negative — "LinkedIn remote usually normalizes to unknown while Gupy
 * carries a known city, so the same posting never merges." That is true,
 * and it is deliberate, not an oversight: the fix AC-014 suggests (let one
 * known side agree with an unknown side) is the exact rule ADR-010
 * Amendment 1 already tried and reversed after it ate a real posting. A
 * false negative here costs one un-logged shadow candidate; the false
 * positive this asymmetry prevents used to cost a real posting silently
 * vanishing outright — now shadow mode already prevents that on its own,
 * but the asymmetry stays, since a wrong "these agree" is still a wrong
 * signal for whatever eventually reads `shadowCandidates`. Not changed.
 */
function locationsAgree(a: Posting, b: Posting): boolean {
  const aKnown = a.location.kind === "known";
  const bKnown = b.location.kind === "known";
  if (!aKnown && !bKnown) return true;
  if (aKnown !== bKnown) return false;
  return (
    normalize((a.location as { city: string }).city) ===
    normalize((b.location as { city: string }).city)
  );
}

/**
 * Layer 2 of dedup (ADR-010, docs/02-architecture.md): same company,
 * textual title similarity within a time window. Layer 1 (exact fingerprint)
 * is already enforced by `PostingsRepository.upsert`'s unique index and is
 * unaffected by any of this — layer 1 is a certain, deterministic identity
 * match with no threshold to get wrong.
 *
 * **Shadow mode (docs/audit PR-006, ADR-010 Amendment 3).** Layer 2 used to
 * call `markDuplicate` on a match, destructively excluding the "loser" from
 * every later stage. Measured false positives at the current threshold —
 * "Direito Trabalhista" vs. "Direito Tributário" (0.57), "Engenharia Civil"
 * vs. "Engenharia de Software" (0.55), among others the audit found — mean
 * this project no longer trusts that threshold to act unsupervised. A
 * match is now only *logged* as a `ShadowDuplicateCandidate`; both postings
 * stay fully active. This trades a real cost (an occasional duplicate
 * notification for a genuine repost) for preventing a worse one (a
 * genuinely distinct opening silently and permanently lost) — the same
 * trade `docs/02-architecture.md`'s principle 1 already makes for a broken
 * source, applied here to an unreliable heuristic instead.
 *
 * Independently re-runnable over the existing corpus without re-collecting
 * (principle 2, docs/02) — the actual test M4 asks for. Tightening
 * `similarityThreshold` after a real calibration pass, or re-running with a
 * wider `windowDays`, touches nothing upstream.
 *
 * Within each company group, postings are processed oldest-`firstSeenAt`
 * first; each one is compared against postings already seen in this pass
 * — the same deterministic "earliest-seen is canonical" framing the
 * destructive version used, kept for `shadowCandidates`' own readability,
 * even though nothing is actually excluded from later comparisons anymore.
 *
 * Grouped by `normalizeCompanyForGrouping`, not the fingerprint's own
 * `normalize(company)` — legal-suffix variance between sources ("Empresa X"
 * on LinkedIn, "Empresa X S.A." on Gupy) used to put the same real company
 * in two different groups, so this function never even title-compared them
 * (docs/audit AC-014).
 */
export function dedupSimilarPostings(
  repository: PostingsRepository,
  config: DedupConfig = DEFAULT_DEDUP_CONFIG,
): DedupOutcome {
  const active = repository.findActive();

  const byCompany = new Map<string, Posting[]>();
  for (const posting of active) {
    const key = normalizeCompanyForGrouping(posting.company);
    const group = byCompany.get(key);
    if (group) {
      group.push(posting);
    } else {
      byCompany.set(key, [posting]);
    }
  }

  const shadowCandidates: ShadowDuplicateCandidate[] = [];

  for (const group of byCompany.values()) {
    const sorted = [...group].sort(
      (a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime(),
    );
    const seen: Posting[] = [];

    for (const candidate of sorted) {
      const canonical = seen.find(
        (earlier) =>
          locationsAgree(earlier, candidate) &&
          withinWindow(
            earlier.firstSeenAt,
            candidate.firstSeenAt,
            config.windowDays,
          ) &&
          computeTitleSimilarity(earlier.title, candidate.title) >=
            config.similarityThreshold,
      );

      if (canonical) {
        shadowCandidates.push({
          candidateFingerprint: candidate.fingerprint,
          candidateTitle: candidate.title,
          canonicalFingerprint: canonical.fingerprint,
          canonicalTitle: canonical.title,
          similarity: computeTitleSimilarity(canonical.title, candidate.title),
        });
      }
      // Not destructive (docs/audit PR-006): every posting stays in `seen`,
      // whether or not it matched something earlier, so it remains active
      // and can itself be compared against by a later candidate.
      seen.push(candidate);
    }
  }

  return { scanned: active.length, markedDuplicate: 0, shadowCandidates };
}
