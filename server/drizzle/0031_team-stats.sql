CREATE TABLE `team_issue_prs` (
	`issue_id` text NOT NULL,
	`pr_url` text NOT NULL,
	PRIMARY KEY(`issue_id`, `pr_url`),
	FOREIGN KEY (`issue_id`) REFERENCES `team_issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pr_url`) REFERENCES `team_prs`(`url`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `team_issue_prs_pr_idx` ON `team_issue_prs` (`pr_url`);--> statement-breakpoint
CREATE TABLE `team_issue_states` (
	`issue_id` text NOT NULL,
	`seq` integer NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	PRIMARY KEY(`issue_id`, `seq`),
	FOREIGN KEY (`issue_id`) REFERENCES `team_issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `team_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`status` text NOT NULL,
	`status_type` text NOT NULL,
	`assignee_id` text,
	`assignee_name` text,
	`creator_id` text,
	`creator_name` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`canceled_at` integer,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	`synced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_issues_identifier_idx` ON `team_issues` (`identifier`);--> statement-breakpoint
CREATE TABLE `team_prs` (
	`url` text PRIMARY KEY NOT NULL,
	`repo` text NOT NULL,
	`number` integer NOT NULL,
	`github_id` integer,
	`state` text,
	`draft` integer,
	`merged_at` integer,
	`closed_at` integer,
	`additions` integer,
	`deletions` integer,
	`author_login` text,
	`created_at` integer,
	`read_at` integer NOT NULL,
	`read_error` text
);
--> statement-breakpoint
CREATE TABLE `team_sync` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`status` text NOT NULL,
	`updated_after` integer,
	`progress` text NOT NULL,
	`error` text,
	`issues` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `team_users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`active` integer NOT NULL
);
