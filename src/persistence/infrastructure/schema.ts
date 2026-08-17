import {
  index,
  integer,
  real,
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
    // When the SOURCE published the posting, as opposed to firstSeenAt,
    // which is when we first observed it. The recency window (ADR-019)
    // needs the former: a posting published last month and first collected
    // today is old, and firstSeenAt cannot say so.
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
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
    // A human decision, not a scoring outcome (M9 feedback, pulled forward
    // early) — a posting rejected here stays rejected across a profile
    // change, unlike `discard` the *verdict*, which is derived from
    // scoring and re-evaluates every time the profile does. Null means "no
    // decision"; once set, never cleared by anything but another explicit
    // discard call — there is no "undiscard" (see `postings-repository.ts`).
    discardedAt: integer("discarded_at", { mode: "timestamp_ms" }),
    // Free text, optional. Not read by any scoring or matching path — a
    // note for the human who made the call, not an input to the pipeline.
    discardReason: text("discard_reason"),
  },
  (table) => [
    uniqueIndex("postings_fingerprint_unique").on(table.fingerprint),
    index("postings_company_idx").on(table.company),
  ],
);

/**
 * Stage A's cache (ADR-007: keyed `(fingerprint, promptVersion)`). One row
 * per posting per prompt version — re-extracting the same posting under the
 * same prompt is a cache hit, and a prompt change during M7 calibration
 * produces a new key rather than invalidating what came before, so old and
 * new prompt results can be compared side by side.
 *
 * `requirements` is the JSON-serialized `Requirement[]` (docs/04). Stored as
 * text, not normalized into rows, because it is never queried by field —
 * only ever read back whole for stage B or the digest.
 */
export const extractions = sqliteTable(
  "extractions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fingerprint: text("fingerprint").notNull(),
    promptVersion: text("prompt_version").notNull(),
    requirements: text("requirements").notNull(),
    // 'internship' | 'trainee' | 'junior' | 'mid' | 'senior' | null —
    // mirrors Posting.seniority. Cached alongside requirements (v2 prompt)
    // so a cache hit still has a value to write back onto the posting row.
    seniority: text("seniority"),
    experienceYears: integer("experience_years"),
    extractedAt: integer("extracted_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("extractions_fingerprint_prompt_unique").on(
      table.fingerprint,
      table.promptVersion,
    ),
  ],
);

/**
 * Stage B's cache (ADR-007: keyed `(fingerprint, profileHash, promptVersion)`).
 * `profileHash` is what makes this cache correct rather than merely fast:
 * editing the profile must invalidate every match that used the old one, and
 * a stale match is worse than a missing one — it is a wrong answer that
 * looks computed (`05-domain-model.md`).
 *
 * `matches` is the JSON-serialized `Match[]` for every requirement in the
 * corresponding extraction, for the same reason `requirements` above is text:
 * read back whole, never queried by field.
 */
export const matches = sqliteTable(
  "matches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fingerprint: text("fingerprint").notNull(),
    profileHash: text("profile_hash").notNull(),
    promptVersion: text("prompt_version").notNull(),
    matches: text("matches").notNull(),
    matchedAt: integer("matched_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("matches_fingerprint_profile_prompt_unique").on(
      table.fingerprint,
      table.profileHash,
      table.promptVersion,
    ),
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
  // The rest (docs/11-known-issues.md B2): a `collect` run with
  // `collectedCount: N, normalizedCount: 0` used to be unexplainable after
  // the fact — recency window, a missing normalizer and a source that
  // returned nothing all looked identical. These four columns are exactly
  // what `executeCollect` already computed in memory and previously
  // discarded once the run row was written.
  tooOldCount: integer("too_old_count").notNull().default(0),
  unnormalizableCount: integer("unnormalizable_count").notNull().default(0),
  // docs/audit/AUDIT_REPORT.md AC-012: without these, `collectedCount` (raw
  // items that passed a collector's own item schema) could not be checked
  // against how many the source actually returned, or how many silently
  // failed that schema before ever becoming a candidate `Posting`. A
  // collector that cannot report `receivedCount` leaves it 0, same as
  // never having run — honestly incomplete, not a false zero for a source
  // that is actually failing.
  receivedCount: integer("received_count").notNull().default(0),
  schemaRejectedCount: integer("schema_rejected_count").notNull().default(0),
  // The first error message seen this run, collector-reported or a caught
  // exception — null on a clean run. Free text, not structured: the sources
  // of an error message are too varied (an HTTP status line, a Zod issue, a
  // driver exception) to usefully type any tighter than `Error.message`.
  failureReason: text("failure_reason"),
  // JSON-serialized string[] of source names that failed this run — parse
  // with `parseFailedSources` (runs-repository.ts), the same manual
  // serialize/parse precedent `requirements`/`matches` already use rather
  // than drizzle's json column mode. Null, not "[]", when nothing failed.
  failedSources: text("failed_sources"),
  // Same shape as failedSources, for docs/audit AC-013: which source(s)
  // stopped paginating this run because they hit their own cap while the
  // upstream source's last page was still full — a "success" run that
  // silently left more results uncollected, previously invisible.
  truncatedSources: text("truncated_sources"),
  // scoreAndDeliver runs only, from OpenRouterClient.getUsage() (docs/audit
  // AC-015). llmAttempts counts every network attempt regardless of
  // outcome -- calls that never made it into scoredCount at all (a 429, a
  // timeout, a malformed body) were previously invisible to any persisted
  // number. llmCostUsd is a floor, not a reconciled total, whenever
  // llmAttemptsWithoutUsage is nonzero -- the provider's own dashboard is
  // still the source of truth for anything more precise.
  llmAttempts: integer("llm_attempts").notNull().default(0),
  llmCostUsd: real("llm_cost_usd").notNull().default(0),
  llmAttemptsWithoutUsage: integer("llm_attempts_without_usage")
    .notNull()
    .default(0),
});
