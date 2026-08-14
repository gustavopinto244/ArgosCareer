ALTER TABLE `postings` ADD `notified_at` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `filtered_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `scored_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `delivered_count` integer DEFAULT 0 NOT NULL;