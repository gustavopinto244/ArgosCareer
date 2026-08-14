CREATE TABLE `postings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`source_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`company` text NOT NULL,
	`title` text NOT NULL,
	`location_kind` text NOT NULL,
	`location_city` text,
	`work_mode` text NOT NULL,
	`seniority` text,
	`experience_years` integer,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`raw_payload` text NOT NULL,
	`duplicate_of_fingerprint` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `postings_fingerprint_unique` ON `postings` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `postings_company_idx` ON `postings` (`company`);--> statement-breakpoint
CREATE TABLE `runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`outcome` text,
	`collected_count` integer DEFAULT 0 NOT NULL,
	`normalized_count` integer DEFAULT 0 NOT NULL,
	`new_count` integer DEFAULT 0 NOT NULL,
	`already_seen_count` integer DEFAULT 0 NOT NULL,
	`duplicate_count` integer DEFAULT 0 NOT NULL
);
