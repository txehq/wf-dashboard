ALTER TABLE `team_pr_timings` ADD `slowest_workflow` text;--> statement-breakpoint
ALTER TABLE `team_pr_timings` ADD `slowest_ms` integer;--> statement-breakpoint
ALTER TABLE `team_pr_timings` ADD `slowest_after_merge` integer;--> statement-breakpoint
ALTER TABLE `team_pr_timings` ADD `read_error` text;