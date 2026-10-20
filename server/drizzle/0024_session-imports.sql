CREATE TABLE `session_imports` (
	`session_id` text PRIMARY KEY NOT NULL,
	`engine` text NOT NULL,
	`file_path` text NOT NULL,
	`imported_at` integer NOT NULL,
	`cleared_at` integer
);
--> statement-breakpoint
DROP TABLE `sources`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`engine` text DEFAULT 'claude' NOT NULL,
	`run_id` text,
	`live_id` text,
	`file_path` text NOT NULL,
	`cwd` text,
	`title` text,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL,
	`has_lfg` integer DEFAULT false NOT NULL,
	`has_ic` integer DEFAULT false NOT NULL,
	`parse_offset` integer DEFAULT 0 NOT NULL,
	`parse_state` text NOT NULL,
	`variant_id` text,
	`variant_binding` text,
	`archived_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`live_id`) REFERENCES `live_sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_sessions`("id", "engine", "run_id", "live_id", "file_path", "cwd", "title", "started_at", "ended_at", "has_lfg", "has_ic", "parse_offset", "parse_state", "variant_id", "variant_binding", "archived_at", "created_at") SELECT "id", "engine", "run_id", "live_id", "file_path", "cwd", "title", "started_at", "ended_at", "has_lfg", "has_ic", "parse_offset", "parse_state", "variant_id", "variant_binding", "archived_at", "created_at" FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_file_path_unique` ON `sessions` (`file_path`);--> statement-breakpoint
CREATE INDEX `sessions_variant_idx` ON `sessions` (`variant_id`);--> statement-breakpoint
CREATE INDEX `sessions_run_idx` ON `sessions` (`run_id`);--> statement-breakpoint
CREATE INDEX `sessions_started_at_idx` ON `sessions` (`started_at`,`id`);--> statement-breakpoint
-- 现在已在 dashboard 中的 session 全部保留为已导入（Contracts 25.1）
INSERT INTO `session_imports`("session_id", "engine", "file_path", "imported_at", "cleared_at") SELECT "id", "engine", "file_path", "created_at", NULL FROM `sessions`;