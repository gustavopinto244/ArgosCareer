import { and, eq } from "drizzle-orm";
import { Requirement } from "../../scoring/domain/types";
import { Db } from "./db";
import { extractions } from "./schema";

/**
 * Stage A's cache, keyed `(fingerprint, promptVersion)` (ADR-007). Upsert
 * rather than insert, matching every other stage's write rule: writing the
 * same extraction twice is indistinguishable from writing it once, so a
 * re-run after a crash costs nothing extra.
 */
export class ExtractionsRepository {
  constructor(private readonly db: Db) {}

  upsert(
    fingerprint: string,
    promptVersion: string,
    requirements: readonly Requirement[],
    extractedAt: Date,
  ): void {
    const existing = this.db
      .select()
      .from(extractions)
      .where(
        and(
          eq(extractions.fingerprint, fingerprint),
          eq(extractions.promptVersion, promptVersion),
        ),
      )
      .get();

    const serialized = JSON.stringify(requirements);

    if (existing) {
      this.db
        .update(extractions)
        .set({ requirements: serialized, extractedAt })
        .where(eq(extractions.id, existing.id))
        .run();
    } else {
      this.db
        .insert(extractions)
        .values({
          fingerprint,
          promptVersion,
          requirements: serialized,
          extractedAt,
        })
        .run();
    }
  }

  find(fingerprint: string, promptVersion: string): Requirement[] | null {
    const row = this.db
      .select()
      .from(extractions)
      .where(
        and(
          eq(extractions.fingerprint, fingerprint),
          eq(extractions.promptVersion, promptVersion),
        ),
      )
      .get();

    return row ? (JSON.parse(row.requirements) as Requirement[]) : null;
  }
}
