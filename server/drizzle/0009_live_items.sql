-- A Live item corresponds to one Claude Code session (Contracts 14.1): one row per start or resume becomes one item with
-- several processes. Migrations run in a transaction (drizzle's migrator), where PRAGMA foreign_keys has no effect: copy
-- the old data into staging tables without foreign keys, drop the old tables once nothing references them, then
-- recreate them under their final names parents first and write the data back, so foreign keys hold on every write.
--
-- Which item each old row joins and which process it becomes: rows with the same claude_session_id merge into one item;
-- a resumed row joins the item of the session resumed_from points to when that session has a row. The earliest row of
-- an item represents it (id and start parameters)
CREATE TABLE `__live_map` (
	`old_id` text PRIMARY KEY NOT NULL,
	`live_id` text NOT NULL,
	`process_id` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__live_map` (`old_id`, `live_id`, `process_id`)
SELECT l.`id`,
	(SELECT r.`id` FROM `live_sessions` r
		WHERE r.`claude_session_id` = (CASE
			WHEN l.`resumed_from` IS NOT NULL
				AND EXISTS (SELECT 1 FROM `live_sessions` x WHERE x.`claude_session_id` = l.`resumed_from`)
			THEN l.`resumed_from`
			ELSE l.`claude_session_id` END)
		ORDER BY r.`created_at`, r.`id` LIMIT 1),
	row_number() OVER (ORDER BY l.`created_at`, l.`id`)
FROM `live_sessions` l;
--> statement-breakpoint
CREATE TABLE `__old_live_sessions` AS SELECT * FROM `live_sessions`;--> statement-breakpoint
CREATE TABLE `__old_live_events` AS SELECT * FROM `live_events`;--> statement-breakpoint
CREATE TABLE `__live_links` AS
SELECT s.`id` AS `session_id`, m.`live_id` AS `live_id`
FROM `sessions` s JOIN `__live_map` m ON m.`old_id` = s.`live_id`;
--> statement-breakpoint
UPDATE `sessions` SET `live_id` = NULL WHERE `live_id` IS NOT NULL;--> statement-breakpoint
DROP TABLE `live_events`;--> statement-breakpoint
DROP TABLE `live_sessions`;--> statement-breakpoint
CREATE TABLE `live_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`claude_session_id` text NOT NULL,
	`title` text NOT NULL,
	`environment` text NOT NULL,
	`workflow` text,
	`input` text,
	`task_id` text,
	`cwd` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `live_sessions_claude_session_id_unique` ON `live_sessions` (`claude_session_id`);--> statement-breakpoint
CREATE INDEX `live_sessions_updated_at_idx` ON `live_sessions` (`updated_at`);--> statement-breakpoint
-- Title (Contracts 14.3): a new item takes the first 40 characters of its input; an item started from an existing
-- session takes that session's title. updated_at is the latest start or end time of its processes
INSERT INTO `live_sessions` (`id`, `claude_session_id`, `title`, `environment`, `workflow`, `input`, `task_id`, `cwd`, `created_at`, `updated_at`)
SELECT r.`id`, r.`claude_session_id`,
	CASE WHEN r.`workflow` IS NOT NULL
		THEN trim(substr('/' || r.`workflow` || ' ' || coalesce(r.`input`, (SELECT t.`input` FROM `tasks` t WHERE t.`id` = r.`task_id`), r.`task_id`, ''), 1, 40))
		ELSE coalesce((SELECT s.`title` FROM `sessions` s WHERE s.`id` = r.`claude_session_id`), 'session ' || substr(r.`claude_session_id`, 1, 8))
	END,
	r.`environment`, r.`workflow`, r.`input`, r.`task_id`, r.`cwd`, r.`created_at`,
	(SELECT max(max(l.`created_at`, coalesce(l.`ended_at`, 0)))
		FROM `__old_live_sessions` l JOIN `__live_map` m ON m.`old_id` = l.`id`
		WHERE m.`live_id` = r.`id`)
FROM `__old_live_sessions` r
WHERE r.`id` IN (SELECT `live_id` FROM `__live_map`);
--> statement-breakpoint
CREATE TABLE `live_processes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`live_id` text NOT NULL,
	`kind` text NOT NULL,
	`variant_id` text,
	`pid` integer,
	`status` text DEFAULT 'running' NOT NULL,
	`exit_code` integer,
	`error` text,
	`driver` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`live_id`) REFERENCES `live_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `live_processes_live_idx` ON `live_processes` (`live_id`,`id`);--> statement-breakpoint
CREATE INDEX `live_processes_status_idx` ON `live_processes` (`status`);--> statement-breakpoint
INSERT INTO `live_processes` (`id`, `live_id`, `kind`, `variant_id`, `pid`, `status`, `exit_code`, `error`, `driver`, `started_at`, `ended_at`)
SELECT m.`process_id`, m.`live_id`,
	CASE WHEN l.`resumed_from` IS NULL THEN 'start' ELSE 'resume' END,
	l.`variant_id`, l.`pid`, l.`status`, l.`exit_code`, l.`error`, l.`driver`, l.`created_at`, l.`ended_at`
FROM `__old_live_sessions` l JOIN `__live_map` m ON m.`old_id` = l.`id`;
--> statement-breakpoint
CREATE TABLE `live_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`live_id` text NOT NULL,
	`process_id` integer,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`live_id`) REFERENCES `live_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`process_id`) REFERENCES `live_processes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `live_events_live_idx` ON `live_events` (`live_id`,`id`);--> statement-breakpoint
-- The start event of a formerly resumed row becomes resume
INSERT INTO `live_events` (`id`, `live_id`, `process_id`, `at`, `kind`, `payload`)
SELECT e.`id`, m.`live_id`, m.`process_id`, e.`at`,
	CASE WHEN e.`kind` = 'start' AND l.`resumed_from` IS NOT NULL THEN 'resume' ELSE e.`kind` END,
	e.`payload`
FROM `__old_live_events` e
	JOIN `__live_map` m ON m.`old_id` = e.`live_id`
	JOIN `__old_live_sessions` l ON l.`id` = e.`live_id`;
--> statement-breakpoint
UPDATE `sessions` SET `live_id` = (SELECT k.`live_id` FROM `__live_links` k WHERE k.`session_id` = `sessions`.`id`)
WHERE `id` IN (SELECT `session_id` FROM `__live_links`);
--> statement-breakpoint
DROP TABLE `__live_links`;--> statement-breakpoint
DROP TABLE `__old_live_events`;--> statement-breakpoint
DROP TABLE `__old_live_sessions`;--> statement-breakpoint
DROP TABLE `__live_map`;
