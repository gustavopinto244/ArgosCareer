ALTER TABLE `runs` ADD `received_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `schema_rejected_count` integer DEFAULT 0 NOT NULL;