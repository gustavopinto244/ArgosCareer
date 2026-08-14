import { eq } from "drizzle-orm";
import { Location, Posting, WorkMode } from "../../posting/domain/posting";
import { Db } from "./db";
import { postings } from "./schema";

type PostingRow = typeof postings.$inferSelect;

export interface UpsertResult {
  readonly posting: Posting;
  /** True on first sighting of this fingerprint, false on a re-sighting. */
  readonly wasNew: boolean;
}

function rowToPosting(row: PostingRow): Posting {
  const location: Location =
    row.locationKind === "known" && row.locationCity !== null
      ? { kind: "known", city: row.locationCity }
      : { kind: "unknown" };

  return {
    source: row.source,
    sourceId: row.sourceId,
    fingerprint: row.fingerprint,
    company: row.company,
    title: row.title,
    location,
    workMode: row.workMode as WorkMode,
    seniority: row.seniority as Posting["seniority"],
    experienceYears: row.experienceYears,
    // The stored row has no separate "collectedAt" column — lastSeenAt *is*
    // the most recent observation, which is what collectedAt means for a
    // hydrated (already-persisted) Posting.
    collectedAt: row.lastSeenAt,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    rawPayload: JSON.parse(row.rawPayload) as unknown,
  };
}

/**
 * Persists postings keyed by fingerprint (ADR-007). The one invariant that
 * matters most: `firstSeenAt` is written on insert and never touched again —
 * a naive upsert overwriting it would make every posting look like it was
 * found today after the next re-collection (ADR-007 amendment).
 *
 * Implemented as an explicit select-then-branch inside a transaction rather
 * than `ON CONFLICT DO UPDATE`, so which columns update on a re-sighting
 * (everything except `firstSeenAt`) stays readable instead of implicit in a
 * SQL `SET` clause. Safe without extra locking: this repository is used by a
 * single sequential batch process, not concurrent writers.
 */
export class PostingsRepository {
  constructor(private readonly db: Db) {}

  upsert(posting: Posting): UpsertResult {
    return this.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(postings)
        .where(eq(postings.fingerprint, posting.fingerprint))
        .get();

      const locationCity =
        posting.location.kind === "known" ? posting.location.city : null;

      if (existing) {
        tx.update(postings)
          .set({
            source: posting.source,
            sourceId: posting.sourceId,
            company: posting.company,
            title: posting.title,
            locationKind: posting.location.kind,
            locationCity,
            workMode: posting.workMode,
            seniority: posting.seniority,
            experienceYears: posting.experienceYears,
            lastSeenAt: posting.lastSeenAt,
            rawPayload: JSON.stringify(posting.rawPayload),
            // firstSeenAt is deliberately absent from this SET clause.
          })
          .where(eq(postings.fingerprint, posting.fingerprint))
          .run();
      } else {
        tx.insert(postings)
          .values({
            source: posting.source,
            sourceId: posting.sourceId,
            fingerprint: posting.fingerprint,
            company: posting.company,
            title: posting.title,
            locationKind: posting.location.kind,
            locationCity,
            workMode: posting.workMode,
            seniority: posting.seniority,
            experienceYears: posting.experienceYears,
            firstSeenAt: posting.firstSeenAt,
            lastSeenAt: posting.lastSeenAt,
            rawPayload: JSON.stringify(posting.rawPayload),
          })
          .run();
      }

      const stored = tx
        .select()
        .from(postings)
        .where(eq(postings.fingerprint, posting.fingerprint))
        .get();
      if (!stored) {
        throw new Error(
          `Postings upsert did not persist fingerprint ${posting.fingerprint}`,
        );
      }

      return { posting: rowToPosting(stored), wasNew: !existing };
    });
  }

  findByFingerprint(fingerprint: string): Posting | null {
    const row = this.db
      .select()
      .from(postings)
      .where(eq(postings.fingerprint, fingerprint))
      .get();
    return row ? rowToPosting(row) : null;
  }

  findByCompany(company: string): Posting[] {
    const rows = this.db
      .select()
      .from(postings)
      .where(eq(postings.company, company))
      .all();
    return rows.map(rowToPosting);
  }

  markDuplicate(fingerprint: string, duplicateOfFingerprint: string): void {
    this.db
      .update(postings)
      .set({ duplicateOfFingerprint })
      .where(eq(postings.fingerprint, fingerprint))
      .run();
  }

  count(): number {
    return this.db.select().from(postings).all().length;
  }
}
