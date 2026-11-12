-- Configurable workflows (Contracts 16). Data steps (DEFAULT, UPDATE, DELETE) were added by hand after drizzle-kit and
-- must be kept when regenerating: existing tasks and variants go into dev-workflow, runs and interactive processes take
-- model and effort from their variant, and stage results are recomputed in the new shape.
-- Only ALTER TABLE: rebuilding a referenced table fires foreign key actions through DROP TABLE's implicit DELETE
-- (sessions.variant_id and others would be set to null)
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`base_variant_id` text,
	`definition` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`base_variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
DELETE FROM `stage_spans`;--> statement-breakpoint
DELETE FROM `stage_cycles`;--> statement-breakpoint
DELETE FROM `stage_states`;--> statement-breakpoint
DROP INDEX `stage_cycles_session_workflow_cycle_idx`;--> statement-breakpoint
ALTER TABLE `stage_cycles` ADD `big_stage` text NOT NULL DEFAULT '';--> statement-breakpoint
CREATE UNIQUE INDEX `stage_cycles_session_big_stage_cycle_idx` ON `stage_cycles` (`session_id`,`big_stage`,`cycle`);--> statement-breakpoint
ALTER TABLE `stage_cycles` DROP COLUMN `workflow`;--> statement-breakpoint
DROP INDEX `stage_spans_session_workflow_cycle_stage_idx`;--> statement-breakpoint
ALTER TABLE `stage_spans` ADD `big_stage` text NOT NULL DEFAULT '';--> statement-breakpoint
CREATE UNIQUE INDEX `stage_spans_session_big_stage_cycle_stage_idx` ON `stage_spans` (`session_id`,`big_stage`,`cycle`,`stage`);--> statement-breakpoint
ALTER TABLE `stage_spans` DROP COLUMN `workflow`;--> statement-breakpoint
ALTER TABLE `stage_states` ADD `workflow_id` text NOT NULL DEFAULT '';--> statement-breakpoint
DROP INDEX `tasks_kind_idx`;--> statement-breakpoint
ALTER TABLE `tasks` ADD `workflow_id` text NOT NULL DEFAULT 'dev-workflow';--> statement-breakpoint
ALTER TABLE `tasks` ADD `big_stage` text NOT NULL DEFAULT '';--> statement-breakpoint
UPDATE `tasks` SET `big_stage` = `kind`;--> statement-breakpoint
CREATE INDEX `tasks_workflow_big_stage_idx` ON `tasks` (`workflow_id`,`big_stage`);--> statement-breakpoint
ALTER TABLE `tasks` DROP COLUMN `kind`;--> statement-breakpoint
ALTER TABLE `runs` ADD `model` text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `runs` ADD `effort` text NOT NULL DEFAULT '';--> statement-breakpoint
UPDATE `runs` SET
	`model` = (SELECT `model` FROM `variants` WHERE `variants`.`id` = `runs`.`variant_id`),
	`effort` = (SELECT `effort` FROM `variants` WHERE `variants`.`id` = `runs`.`variant_id`);--> statement-breakpoint
-- Earlier interactive processes started with the variant's --model and --effort; the local configuration passes
-- none and stays empty
ALTER TABLE `live_processes` ADD `model` text;--> statement-breakpoint
ALTER TABLE `live_processes` ADD `effort` text;--> statement-breakpoint
UPDATE `live_processes` SET
	`model` = (SELECT `model` FROM `variants` WHERE `variants`.`id` = `live_processes`.`variant_id`),
	`effort` = (SELECT `effort` FROM `variants` WHERE `variants`.`id` = `live_processes`.`variant_id`)
WHERE `variant_id` IS NOT NULL;--> statement-breakpoint
DROP INDEX `variants_name_unique`;--> statement-breakpoint
ALTER TABLE `variants` ADD `workflow_id` text NOT NULL DEFAULT 'dev-workflow';--> statement-breakpoint
CREATE UNIQUE INDEX `variants_workflow_name_idx` ON `variants` (`workflow_id`,`name`);--> statement-breakpoint
ALTER TABLE `variants` DROP COLUMN `model`;--> statement-breakpoint
ALTER TABLE `variants` DROP COLUMN `effort`;
