-- Workflows have no top-level stages (Contracts 16, revised 2026-10-12): lfg and ic are two workflows, tasks go back to
-- kind, and variants can share a directory. Data steps (DEFAULT, UPDATE, DELETE) were added by hand after drizzle-kit
-- and must be kept when regenerating.
-- Changes: workflows drops base_variant_id (its foreign key requires rebuilding the table; no other table references
-- workflows) and adds eval_kind and copied_from; W36's dev-workflow row is deleted and lfg and ic are written at service
-- start; splitting dev-workflow's variants into lfg and ic and mapping runs and bindings needs markers from the
-- sessions, so workflows/split-dev-workflow.ts does it after migrating in openDatabase. Stage results are cleared and
-- recomputed in the new shape
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`eval_kind` text,
	`definition` text NOT NULL,
	`copied_from` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_workflows`("id", "name", "eval_kind", "definition", "copied_from", "created_at", "updated_at") SELECT "id", "name", NULL, "definition", NULL, "created_at", "updated_at" FROM `workflows` WHERE "id" <> 'dev-workflow';--> statement-breakpoint
DROP TABLE `workflows`;--> statement-breakpoint
ALTER TABLE `__new_workflows` RENAME TO `workflows`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
DELETE FROM `stage_spans`;--> statement-breakpoint
DELETE FROM `stage_cycles`;--> statement-breakpoint
DELETE FROM `stage_states`;--> statement-breakpoint
DROP INDEX `stage_cycles_session_big_stage_cycle_idx`;--> statement-breakpoint
ALTER TABLE `stage_cycles` ADD `workflow` text NOT NULL DEFAULT '';--> statement-breakpoint
CREATE UNIQUE INDEX `stage_cycles_session_workflow_cycle_idx` ON `stage_cycles` (`session_id`,`workflow`,`cycle`);--> statement-breakpoint
ALTER TABLE `stage_cycles` DROP COLUMN `big_stage`;--> statement-breakpoint
DROP INDEX `stage_spans_session_big_stage_cycle_stage_idx`;--> statement-breakpoint
ALTER TABLE `stage_spans` ADD `workflow` text NOT NULL DEFAULT '';--> statement-breakpoint
CREATE UNIQUE INDEX `stage_spans_session_workflow_cycle_stage_idx` ON `stage_spans` (`session_id`,`workflow`,`cycle`,`stage`);--> statement-breakpoint
ALTER TABLE `stage_spans` DROP COLUMN `big_stage`;--> statement-breakpoint
DROP INDEX `tasks_workflow_big_stage_idx`;--> statement-breakpoint
ALTER TABLE `tasks` ADD `kind` text NOT NULL DEFAULT '';--> statement-breakpoint
UPDATE `tasks` SET `kind` = `big_stage`;--> statement-breakpoint
CREATE INDEX `tasks_kind_idx` ON `tasks` (`kind`);--> statement-breakpoint
ALTER TABLE `tasks` DROP COLUMN `workflow_id`;--> statement-breakpoint
ALTER TABLE `tasks` DROP COLUMN `big_stage`;--> statement-breakpoint
ALTER TABLE `variants` ADD `storage_id` text;--> statement-breakpoint
ALTER TABLE `stage_states` DROP COLUMN `workflow_id`;
