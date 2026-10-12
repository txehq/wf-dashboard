CREATE TABLE `live_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`live_id` text NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`live_id`) REFERENCES `live_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `live_events_live_idx` ON `live_events` (`live_id`,`id`);--> statement-breakpoint
CREATE TABLE `live_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`variant_id` text,
	`environment` text NOT NULL,
	`workflow` text,
	`input` text,
	`task_id` text,
	`cwd` text NOT NULL,
	`claude_session_id` text NOT NULL,
	`resumed_from` text,
	`pid` integer,
	`status` text DEFAULT 'running' NOT NULL,
	`exit_code` integer,
	`error` text,
	`driver` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `live_sessions_status_idx` ON `live_sessions` (`status`);--> statement-breakpoint
CREATE INDEX `live_sessions_claude_session_idx` ON `live_sessions` (`claude_session_id`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `live_id` text REFERENCES live_sessions(id);