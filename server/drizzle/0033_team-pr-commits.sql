ALTER TABLE `team_prs` ADD `commits` integer;--> statement-breakpoint
UPDATE `team_sync` SET `progress` = json_set(`progress`, '$.commitsToRead', 0, '$.commitsRead', 0);