CREATE TABLE `team_repo_searches` (
	`repo` text PRIMARY KEY NOT NULL,
	`searched_until` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `team_prs` ADD `read_by` text DEFAULT 'pull' NOT NULL;--> statement-breakpoint
ALTER TABLE `team_users` ADD `github_login` text;--> statement-breakpoint
UPDATE `team_sync` SET `progress` = json_set(`progress`, '$.prsSearched', 0);