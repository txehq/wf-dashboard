ALTER TABLE `live_sessions` ADD `orca_terminal_handle` text;--> statement-breakpoint
ALTER TABLE `live_sessions` ADD `orca_run_id` text;--> statement-breakpoint
ALTER TABLE `live_sessions` ADD `orca_parent_live_id` text;--> statement-breakpoint
ALTER TABLE `variants` ADD `orca_skills` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `variants` ADD `orca_version` text;