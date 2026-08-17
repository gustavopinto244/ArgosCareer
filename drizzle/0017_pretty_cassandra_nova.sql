ALTER TABLE `postings` ADD `score_failure_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `postings` ADD `last_score_failed_at` integer;