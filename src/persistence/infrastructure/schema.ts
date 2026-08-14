import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * One row per posting, keyed by fingerprint (ADR-007). Never deleted — the
 * corpus is a record of everything ever collected, including what a later
 * pre-filter (M5) rejects, because market questions in M10 are about the
 * whole market, not the shortlist (docs/05-domain-model.md).
 *
 * `firstSeenAt` is written once and never touched again by the upsert that
 * writes every other column; `lastSeenAt` moves on every sighting. See the
 * ADR-007 amendment and `postings-repository.ts`.
 *
 * `rawPayload` retains the source's raw JSON so a later Normalize change can
 * re-derive this row without a network request (ADR-007, principle 2).
 */
export const postings = sqliteTable(
  "postings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    source: text("source").notNull(),
    sourceId: text("source_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    company: text("company").notNull(),
    title: text("title").notNull(),
    // 'known' | 'unknown' — mirrors src/posting/domain/posting.ts's Location
    locationKind: text("location_kind").notNull(),
    locationCity: text("location_city"),
    // 'remote' | 'hybrid' | 'onsite' | 'unknown'
    workMode: text("work_mode").notNull(),
    // Null until stage A extraction populates it (M7) — Gupy-sourced
    // postings normalize with no seniority signal of their own.
    seniority: text("seniority"),
    experienceYears: integer("experience_years"),
    // Null when the source did not state one — the pre-filter's expiry rule
    // (M5) treats this as unknown, not automatically pass or fail.
    applicationDeadline: integer("application_deadline", {
      mode: "timestamp_ms",
    }),
    // Null when the source provided no link. The digest (M6) treats the
    // original posting link as mandatory on every entry it can fill in.
    sourceUrl: text("source_url"),
    // Null when the source provided none — stage A (M7) has nothing to
    // extract requirements from, distinct from a genuinely empty posting.
    description: text("description"),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
    rawPayload: text("raw_payload").notNull(),
    // Set by the similarity dedup layer (ADR-0010) when this posting is a
    // near-duplicate, under a different fingerprint, of an earlier one.
    // Null means "not a known duplicate of anything."
    duplicateOfFingerprint: text("duplicate_of_fingerprint"),
    // Null until delivered. Set once and never cleared — a posting already
    // notified is never notified again (ADR-007, M6), the same "write once"
    // discipline firstSeenAt already follows.
    notifiedAt: integer("notified_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("postings_fingerprint_unique").on(table.fingerprint),
    index("postings_company_idx").on(table.company),
  ],
);

/**
 * One row per pipeline execution (docs/08-observability.md). `kind` names
 * the CLI stage that produced it ("collect", "dedup", and later
 * "scoreAndDeliver" per ADR-009) rather than a fixed enum — SQLite has no
 * real enum type, and the set of kinds grows as later milestones add stages.
 */
export const runs = sqliteTable("runs", {
  runId: text("run_id").primaryKey(),
  kind: text("kind").notNull(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  // 'success' | 'failed' — null while the run is still in progress.
  outcome: text("outcome"),
  collectedCount: integer("collected_count").notNull().default(0),
  normalizedCount: integer("normalized_count").notNull().default(0),
  newCount: integer("new_count").notNull().default(0),
  alreadySeenCount: integer("already_seen_count").notNull().default(0),
  duplicateCount: integer("duplicate_count").notNull().default(0),
  // Populated by a "deliver" run (M6): postings that passed the pre-filter,
  // were scored, and were included in the digest actually sent.
  filteredCount: integer("filtered_count").notNull().default(0),
  scoredCount: integer("scored_count").notNull().default(0),
  deliveredCount: integer("delivered_count").notNull().default(0),
});
