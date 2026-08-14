import { normalize } from "../../posting/domain/fingerprint";
import { Posting } from "../../posting/domain/posting";
import { computeTitleSimilarity } from "../../posting/domain/title-similarity";
import { PostingsRepository } from "../infrastructure/postings-repository";

export interface DedupConfig {
  readonly similarityThreshold: number;
  readonly windowDays: number;
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
 */
export function dedupSimilarPostings(
  repository: PostingsRepository,
  config: DedupConfig = DEFAULT_DEDUP_CONFIG,
): DedupOutcome {
  const active = repository.findActive();

  const byCompany = new Map<string, Posting[]>();
  for (const posting of active) {
    const key = normalize(posting.company);
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
