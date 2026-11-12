ALTER TABLE `session_skill_scans` ADD `injections_scanned` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `session_skills` ADD `injected` integer DEFAULT false NOT NULL;