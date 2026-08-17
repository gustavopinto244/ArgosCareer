import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import {
  Location,
  Posting,
  Seniority,
  WorkMode,
} from "../../posting/domain/posting";
import { Db } from "./db";
import { postings } from "./schema";

type PostingRow = typeof postings.$inferSelect;

export interface UpsertResult {
  readonly posting: Posting;
  /** True on first sighting of this fingerprint, false on a re-sighting. */
  readonly wasNew: boolean;
}

/** `rawPayload` is `unknown` by contract (`posting.ts`) — an opaque debug/
 * audit snapshot, never read by any pipeline logic (only ever written by
 * `upsert` with `JSON.stringify`'s own output). A restore or manual edit
 * that truncates or corrupts it (docs/audit AC-031) must not take down
 * *every* read of the row it belongs to — `findActive`/`findUnnotified`/
 * dedup all hydrate through this same path — so a parse failure degrades to
 * a marker value instead of throwing. */
function parseRawPayload(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { corrupted: true };
  }
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
    applicationDeadline: row.applicationDeadline,
    publishedAt: row.publishedAt,
    sourceUrl: row.sourceUrl,
    description: row.description,
    // The stored row has no separate "collectedAt" column — lastSeenAt *is*
    // the most recent observation, which is what collectedAt means for a
    // hydrated (already-persisted) Posting.
    collectedAt: row.lastSeenAt,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    rawPayload: parseRawPayload(row.rawPayload),
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
 * SQL `SET` clause.
 *
 * Safe under concurrent writers, including a second OS process (docs/audit
 * AC-020 re-examined this and confirmed it, rather than assuming it): the
 * select and the branch it drives are inside one `db.transaction()`, and
 * SQLite serializes write transactions at the database-file level — a
 * second connection's write transaction blocks until the first commits (up
 * to `better-sqlite3`'s 5s default `busy_timeout`), it never interleaves
 * with it. What this does **not** cover is a race spanning *multiple*
 * transactions — `executeDeliver`'s `findUnnotified` → score → notify →
 * `markNotified` sequence is not one atomic unit, so two full delivery runs
 * overlapping across processes can still both read the same unnotified
 * postings before either marks them. That is `RunLock`'s job
 * (`run-lock.ts`), not this repository's, and `RunLock`'s own known,
 * accepted limitation (in-process only, ADR-024) is what actually leaves
 * that specific race open — not anything in this method.
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
            applicationDeadline: posting.applicationDeadline,
            publishedAt: posting.publishedAt,
            sourceUrl: posting.sourceUrl,
            description: posting.description,
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
            applicationDeadline: posting.applicationDeadline,
            publishedAt: posting.publishedAt,
            sourceUrl: posting.sourceUrl,
            description: posting.description,
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

  /**
   * Clears every similarity-duplicate flag, so a corrected dedup pass can
   * re-decide from scratch.
   *
   * Non-destructive by construction: `markDuplicate` only ever sets a
   * column, so nothing was deleted when a posting was flagged, and clearing
   * the flag restores it whole. That is what makes fixing a dedup bug a
   * re-run rather than a re-collection — the corpus is not a cache
   * (`05-domain-model.md`), and this is the payoff for it.
   */
  clearDuplicateFlags(): number {
    const affected = this.db
      .select()
      .from(postings)
      .where(isNotNull(postings.duplicateOfFingerprint))
      .all().length;
    this.db
      .update(postings)
      .set({ duplicateOfFingerprint: null })
      .where(isNotNull(postings.duplicateOfFingerprint))
      .run();
    return affected;
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

  /**
   * Postings not already flagged as a known duplicate — the candidate pool
   * for the similarity dedup layer (ADR-0010). A posting already marked
   * duplicate is excluded rather than compared again; only canonical
   * postings are compared against each other.
   */
  findActive(): Posting[] {
    const rows = this.db
      .select()
      .from(postings)
      .where(isNull(postings.duplicateOfFingerprint))
      .all();
    return rows.map(rowToPosting);
  }

  /**
   * Active postings not yet notified — the candidate pool for a digest.
   * `notifiedAt` is set once and never cleared (ADR-007's "write once"
   * discipline, applied to delivery): a posting already notified is never
   * notified again, so it drops out of this pool permanently once sent.
   */
  findUnnotified(): Posting[] {
    const rows = this.db
      .select()
      .from(postings)
      .where(
        and(
          isNull(postings.duplicateOfFingerprint),
          isNull(postings.notifiedAt),
          // A human's "no" is permanent (see `discard` below) — the digest
          // candidate pool excludes it the same way it excludes a posting
          // already sent, not because scoring said no but because a person
          // already did.
          isNull(postings.discardedAt),
        ),
      )
      .all();
    return rows.map(rowToPosting);
  }

  markNotified(fingerprint: string, notifiedAt: Date): void {
    this.db
      .update(postings)
      .set({ notifiedAt })
      .where(eq(postings.fingerprint, fingerprint))
      .run();
  }

  /**
   * How many consecutive `scoreAndDeliver` runs have failed to score this
   * posting (docs/audit PR-002). `executeDeliver` reads this before spending
   * a model call, so a posting stuck failing indefinitely (a permanently
   * malformed description, not a transient provider hiccup) eventually stops
   * being retried. 0 for a fingerprint with no row — defensive, not expected
   * in practice, since every caller reads this only for a posting it already
   * has from `findUnnotified`.
   */
  getScoreFailureCount(fingerprint: string): number {
    const row = this.db
      .select({ scoreFailureCount: postings.scoreFailureCount })
      .from(postings)
      .where(eq(postings.fingerprint, fingerprint))
      .get();
    return row?.scoreFailureCount ?? 0;
  }

  /**
   * Increments the failure counter and records when it last happened
   * (docs/audit PR-002). An atomic `SET x = x + 1` rather than read-then-write
   * — this repository already documents (see the class doc comment) that
   * cross-transaction races are RunLock's job, not this one's, but an
   * increment is cheap to make race-safe on its own regardless.
   */
  recordScoreFailure(fingerprint: string, failedAt: Date): void {
    this.db
      .update(postings)
      .set({
        scoreFailureCount: sql`${postings.scoreFailureCount} + 1`,
        lastScoreFailedAt: failedAt,
      })
      .where(eq(postings.fingerprint, fingerprint))
      .run();
  }

  /**
   * Resets the failure counter after a scoring attempt actually succeeds
   * (docs/audit PR-002) — a posting that failed twice and then scored
   * cleanly should not carry a stale near-ceiling count forward into
   * whatever reads it next.
   */
  clearScoreFailures(fingerprint: string): void {
    this.db
      .update(postings)
      .set({ scoreFailureCount: 0, lastScoreFailedAt: null })
      .where(eq(postings.fingerprint, fingerprint))
      .run();
  }

  /**
   * Records a human decision that this posting is never worth surfacing
   * again — the manual counterpart to the scored `discard` verdict, and
   * independent of it: this survives a profile edit or a re-run under a new
   * prompt version, neither of which touches it, because it was never a
   * function of either.
   *
   * Write-once, same discipline as `notifiedAt`: a fingerprint already
   * discarded is left untouched (both timestamp and reason) rather than
   * overwritten by a second call. There is deliberately no "undiscard" —
   * reversing a bad call means clearing the column directly against the
   * database, a rare enough operation that a dedicated code path for it
   * would be unused machinery, not a feature.
   *
   * Returns `false` when the fingerprint does not exist, so a caller (the
   * CLI, the API) can report "no such posting" instead of silently
   * succeeding on a typo.
   */
  discard(
    fingerprint: string,
    discardedAt: Date,
    reason: string | null,
  ): boolean {
    const result = this.db
      .update(postings)
      .set({ discardedAt, discardReason: reason })
      .where(
        and(
          eq(postings.fingerprint, fingerprint),
          isNull(postings.discardedAt),
        ),
      )
      .run();
    if (result.changes > 0) return true;
    // `changes === 0` is ambiguous between "no such fingerprint" and
    // "already discarded" — the write-once guard above produces the same
    // count either way. Distinguish them with a second, cheap read so the
    // caller's 404 is accurate: reported as "not found" only when the row
    // genuinely does not exist, not when it silently no-ops on a repeat call.
    const exists = this.db
      .select({ fingerprint: postings.fingerprint })
      .from(postings)
      .where(eq(postings.fingerprint, fingerprint))
      .get();
    return exists !== undefined;
  }

  /**
   * Written by stage A (M7) once extraction succeeds — `05-domain-model.md`:
   * these are fields the score sees, not only the pre-filter's title
   * pattern. Unlike `firstSeenAt`, this is a plain overwrite: a prompt
   * improvement re-extracting the same posting should replace the old
   * values, not be blocked by a "write once" rule that only makes sense for
   * a sighting timestamp.
   */
  updateExtractedFields(
    fingerprint: string,
    seniority: Seniority | null,
    experienceYears: number | null,
  ): void {
    this.db
      .update(postings)
      .set({ seniority, experienceYears })
      .where(eq(postings.fingerprint, fingerprint))
      .run();
  }
}
