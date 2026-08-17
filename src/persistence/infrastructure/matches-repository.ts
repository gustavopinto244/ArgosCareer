import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { Match, MatchSchema } from "../../scoring/domain/types";
import { Db } from "./db";
import { matches } from "./schema";

const CachedMatchesSchema = z.array(MatchSchema);

/** `null` on anything that is not a valid `Match[]` — same reasoning as
 * `extractions-repository.ts`'s `parseRequirements` (docs/audit AC-031,
 * PR-013): a corrupted cache row, or a structurally-valid-JSON array whose
 * elements are not real `Match`es (an invalid `status` enum, a nested
 * `requirement` missing a field), must read back as a miss, not throw and
 * take down whatever read it. */
function parseMatches(value: string): Match[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const result = CachedMatchesSchema.safeParse(parsed);
  return result.success ? (result.data as Match[]) : null;
}

/**
 * Stage B's cache, keyed by the composite `(fingerprint, profileHash,
 * promptVersion, model, requirementsHash)` (ADR-007, docs/audit
 * AC-007/PR-017). `profileHash` is what makes this cache correct against a
 * profile edit; `requirementsHash` against a Stage A change (a new prompt
 * version, or a content-hash-triggered re-extraction) that leaves
 * `fingerprint`/`profileHash`/`promptVersion` untouched from Stage B's own
 * point of view; `model` against switching `LLM_MODEL`. Before PR-017, only
 * `(fingerprint, profileHash, promptVersion)` was the row's actual database
 * identity — `model`/`requirementsHash` were checked after a row was
 * already found, so a different model or requirement set under that same
 * triple silently overwrote a still-valid match instead of coexisting
 * alongside it, enforced now by `matches_composite_identity_unique`.
 */
export class MatchesRepository {
  constructor(private readonly db: Db) {}

  upsert(
    fingerprint: string,
    profileHash: string,
    promptVersion: string,
    model: string,
    requirementsHash: string,
    matchList: readonly Match[],
    matchedAt: Date,
  ): void {
    const existing = this.db
      .select()
      .from(matches)
      .where(
        and(
          eq(matches.fingerprint, fingerprint),
          eq(matches.profileHash, profileHash),
          eq(matches.promptVersion, promptVersion),
          eq(matches.model, model),
          eq(matches.requirementsHash, requirementsHash),
        ),
      )
      .get();

    const serialized = JSON.stringify(matchList);

    if (existing) {
      this.db
        .update(matches)
        .set({ matches: serialized, model, requirementsHash, matchedAt })
        .where(eq(matches.id, existing.id))
        .run();
    } else {
      this.db
        .insert(matches)
        .values({
          fingerprint,
          profileHash,
          promptVersion,
          model,
          requirementsHash,
          matches: serialized,
          matchedAt,
        })
        .run();
    }
  }

  find(
    fingerprint: string,
    profileHash: string,
    promptVersion: string,
    model: string,
    requirementsHash: string,
  ): Match[] | null {
    const row = this.db
      .select()
      .from(matches)
      .where(
        and(
          eq(matches.fingerprint, fingerprint),
          eq(matches.profileHash, profileHash),
          eq(matches.promptVersion, promptVersion),
          eq(matches.model, model),
          eq(matches.requirementsHash, requirementsHash),
        ),
      )
      .get();
    if (!row) return null;

    return parseMatches(row.matches);
  }
}
