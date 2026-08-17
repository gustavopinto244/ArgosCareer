DROP INDEX `extractions_fingerprint_prompt_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `extractions_composite_identity_unique` ON `extractions` (`fingerprint`,`prompt_version`,`model`,`content_hash`);--> statement-breakpoint
DROP INDEX `matches_fingerprint_profile_prompt_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `matches_composite_identity_unique` ON `matches` (`fingerprint`,`profile_hash`,`prompt_version`,`model`,`requirements_hash`);