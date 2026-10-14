CREATE TABLE `magi_agent_current` (
	`engine` text PRIMARY KEY NOT NULL,
	`live_id` text NOT NULL,
	FOREIGN KEY (`live_id`) REFERENCES `live_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `magi_deploys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`live_id` text NOT NULL,
	`engine` text NOT NULL,
	`status` text NOT NULL,
	`steps` text NOT NULL,
	`error` text,
	`log_file` text NOT NULL,
	`commit` text,
	`backup_file` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`live_id`) REFERENCES `live_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
