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
 * real data — see ADR-0010. */
export const DEFAULT_DEDUP_CONFIG: DedupConfig = {
  similarityThreshold: 0.35,
  windowDays: 14,
};

export interface DedupOutcome {
  readonly scanned: number;
  readonly markedDuplicate: number;
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
 * Merging is destructive — the loser is flagged and drops out of every later
 * stage — so the conservative reading wins wherever the answer is unclear.
 * Both cities known and equal merges; both unknown merges (nothing
 * contradicts); exactly one known does **not**, because that is precisely
 * the shape that ate a real "Pessoa Desenvolvedora Backend Python" in Rio
 * whose canonical had no city at all (ADR-010 Amendment 1).
 *
 * docs/audit AC-014 names this same asymmetry as a cross-source false
 * negative — "LinkedIn remote usually normalizes to unknown while Gupy
 * carries a known city, so the same posting never merges." That is true,
 * and it is deliberate, not an oversight: the fix AC-014 suggests (let one
 * known side agree with an unknown side) is the exact rule ADR-010
 * Amendment 1 already tried and reversed after it ate a real posting. A
 * false negative here costs a redundant Stage A/B call; the false positive
 * this asymmetry prevents costs a real posting silently vanishing. Not
 * changed.
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
 * Layer 2 of dedup (ADR-0010, docs/02-architecture.md): same company,
 * textual title similarity within a time window. Layer 1 (exact fingerprint)
 * is already enforced by `PostingsRepository.upsert`'s unique index; this
 * catches what layer 1 cannot — the same job posted under a superficially
 * different title.
 *
 * Independently re-runnable over the existing corpus without re-collecting
 * (principle 2, docs/02) — the actual test M4 asks for. Tightening
 * `similarityThreshold` after a calibration pass, or re-running with a wider
 * `windowDays`, touches nothing upstream.
 *
 * Within each company group, postings are processed oldest-`firstSeenAt`
 * first; each one is compared only against postings already kept as
 * canonical in this pass, never against another duplicate. This makes the
 * canonical pick deterministic — earliest-seen wins — regardless of the
 * order rows come back from the database.
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

  let markedDuplicate = 0;

  for (const group of byCompany.values()) {
    const sorted = [...group].sort(
      (a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime(),
    );
    const kept: Posting[] = [];

    for (const candidate of sorted) {
      const match = kept.find(
        (canonical) =>
          locationsAgree(canonical, candidate) &&
          withinWindow(
            canonical.firstSeenAt,
            candidate.firstSeenAt,
            config.windowDays,
          ) &&
          computeTitleSimilarity(canonical.title, candidate.title) >=
            config.similarityThreshold,
      );

      if (match) {
        repository.markDuplicate(candidate.fingerprint, match.fingerprint);
        markedDuplicate += 1;
      } else {
        kept.push(candidate);
      }
    }
  }

  return { scanned: active.length, markedDuplicate };
}
