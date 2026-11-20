CREATE TABLE `team_pr_timing_windows` (
	`repo` text NOT NULL,
	`from` integer NOT NULL,
	`to` integer NOT NULL,
	PRIMARY KEY(`repo`, `from`)
);
--> statement-breakpoint
CREATE TABLE `team_pr_timings` (
	`url` text PRIMARY KEY NOT NULL,
	`repo` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`author_login` text,
	`created_at` integer NOT NULL,
	`ready_at` integer,
	`merged_at` integer NOT NULL,
	`ci_started_at` integer,
	`ci_ended_at` integer,
	`ci_runs` integer NOT NULL,
	`ci_all_succeeded` integer,
	`read_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `team_pr_timings_merged_idx` ON `team_pr_timings` (`merged_at`);--> statement-breakpoint
UPDATE `team_sync` SET `progress` = json_set(`progress`, '$.timingsRead', 0);