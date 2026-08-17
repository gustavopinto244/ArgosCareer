PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`outcome` text,
	`collected_count` integer DEFAULT 0 NOT NULL,
	`normalized_count` integer DEFAULT 0 NOT NULL,
	`new_count` integer DEFAULT 0 NOT NULL,
	`already_seen_count` integer DEFAULT 0 NOT NULL,
	`duplicate_count` integer DEFAULT 0 NOT NULL,
	`filtered_count` integer DEFAULT 0 NOT NULL,
	`scored_count` integer DEFAULT 0 NOT NULL,
	`delivered_count` integer DEFAULT 0 NOT NULL,
	`too_old_count` integer DEFAULT 0 NOT NULL,
	`unnormalizable_count` integer DEFAULT 0 NOT NULL,
	`received_count` integer,
	`schema_rejected_count` integer,
	`failure_reason` text,
	`failed_sources` text,
	`truncated_sources` text,
	`attempted_sources` text,
	`llm_attempts` integer DEFAULT 0 NOT NULL,
	`llm_cost_usd` real DEFAULT 0 NOT NULL,
	`llm_attempts_without_usage` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_runs`("run_id", "kind", "started_at", "finished_at", "outcome", "collected_count", "normalized_count", "new_count", "already_seen_count", "duplicate_count", "filtered_count", "scored_count", "delivered_count", "too_old_count", "unnormalizable_count", "received_count", "schema_rejected_count", "failure_reason", "failed_sources", "truncated_sources", "attempted_sources", "llm_attempts", "llm_cost_usd", "llm_attempts_without_usage") SELECT "run_id", "kind", "started_at", "finished_at", "outcome", "collected_count", "normalized_count", "new_count", "already_seen_count", "duplicate_count", "filtered_count", "scored_count", "delivered_count", "too_old_count", "unnormalizable_count", "received_count", "schema_rejected_count", "failure_reason", "failed_sources", "truncated_sources", "attempted_sources", "llm_attempts", "llm_cost_usd", "llm_attempts_without_usage" FROM `runs`;--> statement-breakpoint
DROP TABLE `runs`;--> statement-breakpoint
ALTER TABLE `__new_runs` RENAME TO `runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;