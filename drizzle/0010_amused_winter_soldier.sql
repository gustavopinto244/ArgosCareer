ALTER TABLE `runs` ADD `too_old_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `unnormalizable_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `failure_reason` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `failed_sources` text;