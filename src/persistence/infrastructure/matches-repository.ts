import { and, eq } from "drizzle-orm";
import { Match } from "../../scoring/domain/types";
import { Db } from "./db";
import { matches } from "./schema";

export interface FingerprintedMatches {
  readonly fingerprint: string;
  readonly matches: readonly Match[];
}

/**
 * Stage B's cache, keyed `(fingerprint, profileHash, promptVersion)`
 * (ADR-007). `profileHash` is what makes this cache correct: editing the
 * profile must produce a new key, never silently reuse a match computed
 * against the old one.
 */
export class MatchesRepository {
  constructor(private readonly db: Db) {}

  upsert(
    fingerprint: string,
    profileHash: string,
    promptVersion: string,
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
        ),
      )
      .get();

    const serialized = JSON.stringify(matchList);

    if (existing) {
      this.db
        .update(matches)
        .set({ matches: serialized, matchedAt })
        .where(eq(matches.id, existing.id))
        .run();
    } else {
      this.db
        .insert(matches)
        .values({
          fingerprint,
          profileHash,
          promptVersion,
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
  ): Match[] | null {
    const row = this.db
      .select()
      .from(matches)
      .where(
        and(
          eq(matches.fingerprint, fingerprint),
          eq(matches.profileHash, profileHash),
          eq(matches.promptVersion, promptVersion),
        ),
      )
      .get();

    return row ? (JSON.parse(row.matches) as Match[]) : null;
  }

  /**
   * Every cached match for the current profile and prompt version — M10's
   * "high-compatibility postings" filter needs a verdict per posting, and a
   * verdict needs matches. Scoped to `(profileHash, promptVersion)` for the
   * same reason `find` is: a match computed against a superseded profile is
   * a wrong answer that looks computed, not a data point (`05-domain-model.md`).
   */
  findAllForProfile(
    profileHash: string,
    promptVersion: string,
  ): FingerprintedMatches[] {
    const rows = this.db
      .select()
      .from(matches)
      .where(
        and(
          eq(matches.profileHash, profileHash),
          eq(matches.promptVersion, promptVersion),
        ),
      )
      .all();

    return rows.map((row) => ({
      fingerprint: row.fingerprint,
      matches: JSON.parse(row.matches) as Match[],
    }));
  }
}
