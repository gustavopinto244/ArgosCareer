CREATE TABLE `delivery_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`content_hash` text NOT NULL,
	`body` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`telegram_message_id` integer,
	`confirmed_at` integer,
	`last_error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_chunks_operation_index_unique` ON `delivery_chunks` (`operation_id`,`chunk_index`);--> statement-breakpoint
CREATE INDEX `delivery_chunks_operation_idx` ON `delivery_chunks` (`operation_id`);--> statement-breakpoint
CREATE TABLE `delivery_operations` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`channel_key` text NOT NULL,
	`content_hash` text NOT NULL,
	`status` text NOT NULL,
	`claimed_by` text,
	`claim_expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_operations_channel_content_unique` ON `delivery_operations` (`channel_key`,`content_hash`);--> statement-breakpoint
CREATE INDEX `delivery_operations_status_idx` ON `delivery_operations` (`status`);