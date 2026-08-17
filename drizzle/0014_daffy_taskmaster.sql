CREATE TABLE `posting_events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`stage` text NOT NULL,
	`outcome` text NOT NULL,
	`reason` text,
	`criteria_hash` text,
	`occurred_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `posting_events_run_id_idx` ON `posting_events` (`run_id`);--> statement-breakpoint
CREATE INDEX `posting_events_fingerprint_idx` ON `posting_events` (`fingerprint`);