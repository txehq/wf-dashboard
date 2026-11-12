-- A Codex draft's Live item has no session id until the draft is prepared and Codex writes its session record
-- (Contracts 17.1): claude_session_id becomes nullable. SQLite cannot change a column constraint, so live_sessions is
-- rebuilt. Migrations run in a transaction (drizzle's migrator), where PRAGMA foreign_keys has no effect: foreign key
-- checks are deferred to commit instead. Copy the old rows into an unconstrained staging table, drop the old table
-- (live_processes and live_events briefly point at missing rows), create the table under its final name and write the
-- same ids back so the references hold again. sessions.live_id is ON DELETE SET NULL and is cleared when the old table
-- is dropped, so it is saved first and written back
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
