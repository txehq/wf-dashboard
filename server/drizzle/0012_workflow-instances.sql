-- workflow 没有大阶段（Contracts 16，2026-10-12 重定）：lfg 与 ic 是两个 workflow，task 回到 kind，variant 可以共用目录。
-- drizzle-kit 生成后手工加入了数据步骤（DEFAULT、UPDATE、DELETE），重新生成时必须保留。
-- 变化：workflows 去掉 base_variant_id（它的外键要求重建这张表；没有其他表引用 workflows），加 eval_kind 与 copied_from；
-- W36 的 dev-workflow 一行删除，lfg 与 ic 由服务启动时写入；dev-workflow 的 variant 拆成 lfg 与 ic 两个、run 与绑定的对应
-- 要读 session 中的标记，在 openDatabase 中迁移之后由 workflows/split-dev-workflow.ts 完成。阶段结果清空，按新形状重算
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
