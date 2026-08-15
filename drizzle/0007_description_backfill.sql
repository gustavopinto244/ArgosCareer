-- Data migration, not a schema change (ADR-014).
--
-- `0004_useful_daimon_hellstrom.sql` added `postings.description` with
-- `ALTER TABLE ... ADD COLUMN`, which SQLite fills with NULL on every row that
-- already existed. Nothing backfilled them afterwards, and a posting already
-- seen is never reprocessed, so those rows kept `description = NULL`
-- permanently — while `raw_payload`, written since 0000, held the full text
-- the whole time.
--
-- The consequence was not cosmetic: stage A extracted zero requirements from
-- them, the empty-category rule then scored them 91-100, and four of the
-- sixteen hand-labelled calibration postings were silently contentless.
--
-- Recovers the text from the payload already on disk. No network call, no
-- re-collection. Idempotent: rows that already have a description are left
-- alone, and re-running changes nothing.
UPDATE postings
SET description = json_extract(raw_payload, '$.description')
WHERE description IS NULL
  AND json_extract(raw_payload, '$.description') IS NOT NULL
  AND trim(json_extract(raw_payload, '$.description')) <> '';

--> statement-breakpoint
-- Stage A's cache is keyed `(fingerprint, prompt_version)` and carries no
-- notion of which description produced it, so the empty extractions written
-- for those postings would keep being served after the backfill above. Drop
-- exactly those: extractions holding no requirements at all. A genuinely
-- requirement-free posting re-extracts once and costs a single call;
-- `stage-a-extractor.ts` no longer writes this row at all for a posting with
-- no description, so this cannot silently accumulate again.
DELETE FROM extractions WHERE requirements = '[]';

--> statement-breakpoint
-- Stage B matches are keyed on the extraction that produced them only
-- indirectly (via fingerprint), so any match list built from a dropped
-- extraction is orphaned. Clearing matches for postings that no longer have
-- a cached extraction keeps the two caches consistent.
DELETE FROM matches
WHERE fingerprint NOT IN (SELECT fingerprint FROM extractions);
