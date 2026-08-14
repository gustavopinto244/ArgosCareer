CREATE TABLE `extractions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fingerprint` text NOT NULL,
	`prompt_version` text NOT NULL,
	`requirements` text NOT NULL,
	`extracted_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `extractions_fingerprint_prompt_unique` ON `extractions` (`fingerprint`,`prompt_version`);--> statement-breakpoint
CREATE TABLE `matches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fingerprint` text NOT NULL,
	`profile_hash` text NOT NULL,
	`prompt_version` text NOT NULL,
	`matches` text NOT NULL,
	`matched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `matches_fingerprint_profile_prompt_unique` ON `matches` (`fingerprint`,`profile_hash`,`prompt_version`);