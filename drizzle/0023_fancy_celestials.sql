CREATE TABLE `partial_matches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fingerprint` text NOT NULL,
	`profile_hash` text NOT NULL,
	`prompt_version` text NOT NULL,
	`model` text NOT NULL,
	`requirements_hash` text NOT NULL,
	`requirement_index` integer NOT NULL,
	`match` text NOT NULL,
	`matched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `partial_matches_semantic_identity_unique` ON `partial_matches` (`fingerprint`,`profile_hash`,`prompt_version`,`model`,`requirements_hash`,`requirement_index`);--> statement-breakpoint
CREATE INDEX `partial_matches_lookup_idx` ON `partial_matches` (`fingerprint`,`profile_hash`,`prompt_version`,`model`,`requirements_hash`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_posting_events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`fingerprint` text,
	`source` text,
	`source_id` text,
	`stage` text NOT NULL,
	`outcome` text NOT NULL,
	`reason` text,
	`criteria_hash` text,
	`metadata` text,
	`occurred_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_posting_events`("id", "run_id", "fingerprint", "source", "source_id", "stage", "outcome", "reason", "criteria_hash", "metadata", "occurred_at") SELECT "id", "run_id", "fingerprint", NULL, NULL, "stage", "outcome", "reason", "criteria_hash", NULL, "occurred_at" FROM `posting_events`;--> statement-breakpoint
DROP TABLE `posting_events`;--> statement-breakpoint
ALTER TABLE `__new_posting_events` RENAME TO `posting_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `posting_events_run_id_idx` ON `posting_events` (`run_id`);--> statement-breakpoint
CREATE INDEX `posting_events_fingerprint_idx` ON `posting_events` (`fingerprint`);--> statement-breakpoint
ALTER TABLE `runs` ADD `triggered_by` text DEFAULT 'internal' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `source_query_stats` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `llm_prompt_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `llm_completion_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `llm_cached_prompt_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `llm_blocked_by_circuit` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `llm_outcome_counts` text;
