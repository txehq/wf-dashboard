CREATE TABLE `ssh_hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`target` text NOT NULL,
	`label` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`checked_at` integer,
	`check` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ssh_hosts_target_unique` ON `ssh_hosts` (`target`);--> statement-breakpoint
ALTER TABLE `live_sessions` ADD `host_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `host_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `remote_path` text;