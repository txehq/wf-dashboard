ALTER TABLE `runs` ADD `invalid_reason` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `grading_status` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `grading_error` text;--> statement-breakpoint
UPDATE `runs` SET `grading_status` = 'done' WHERE EXISTS (SELECT 1 FROM `grades` WHERE `grades`.`run_id` = `runs`.`id`);