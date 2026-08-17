ALTER TABLE `runs` ADD `llm_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `llm_cost_usd` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `llm_attempts_without_usage` integer DEFAULT 0 NOT NULL;