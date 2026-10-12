-- Codex 草稿的交互项在草稿准备完、Codex 写出会话记录之前没有会话 id（Contracts 17.1）：claude_session_id 改为可空。
-- SQLite 不能改列的约束，重建 live_sessions。迁移在一个事务中运行（drizzle 的 migrator），其中 PRAGMA foreign_keys
-- 不起作用：改为推迟外键检查到提交时。先把旧行复制到没有约束的暂存表，删除旧表（live_processes、live_events 暂时
-- 指向不存在的行），再以最终的名字建表并写回同样的 id，引用重新满足。sessions.live_id 是 ON DELETE SET NULL，
-- 删除旧表时会被置空，先记下再写回
PRAGMA defer_foreign_keys = ON;--> statement-breakpoint
CREATE TABLE `__live_links` AS SELECT `id` AS `session_id`, `live_id` FROM `sessions` WHERE `live_id` IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__old_live_sessions` AS SELECT * FROM `live_sessions`;--> statement-breakpoint
DROP TABLE `live_sessions`;--> statement-breakpoint
CREATE TABLE `live_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`claude_session_id` text,
	`engine` text DEFAULT 'claude' NOT NULL,
	`title` text NOT NULL,
	`environment` text NOT NULL,
	`workflow` text,
	`input` text,
	`task_id` text,
	`cwd` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	`hidden_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `live_sessions`("id", "claude_session_id", "engine", "title", "environment", "workflow", "input", "task_id", "cwd", "created_at", "updated_at", "hidden_at") SELECT "id", "claude_session_id", "engine", "title", "environment", "workflow", "input", "task_id", "cwd", "created_at", "updated_at", "hidden_at" FROM `__old_live_sessions`;--> statement-breakpoint
CREATE UNIQUE INDEX `live_sessions_claude_session_id_unique` ON `live_sessions` (`claude_session_id`);--> statement-breakpoint
CREATE INDEX `live_sessions_updated_at_idx` ON `live_sessions` (`updated_at`);--> statement-breakpoint
UPDATE `sessions` SET `live_id` = (SELECT k.`live_id` FROM `__live_links` k WHERE k.`session_id` = `sessions`.`id`)
WHERE `id` IN (SELECT `session_id` FROM `__live_links`);--> statement-breakpoint
DROP TABLE `__live_links`;--> statement-breakpoint
DROP TABLE `__old_live_sessions`;--> statement-breakpoint
ALTER TABLE `workflow_drafts` ADD `name` text;--> statement-breakpoint
ALTER TABLE `workflow_drafts` ADD `error` text;--> statement-breakpoint
ALTER TABLE `workflow_drafts` ADD `steps` text DEFAULT '[]' NOT NULL;
