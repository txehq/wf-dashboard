CREATE TABLE `stage_states` (
	`session_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`folded_seq` integer NOT NULL,
	`folded_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
DROP TABLE `stage_analyses`;--> statement-breakpoint
DROP TABLE `stage_checks`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_stage_cycles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`workflow` text NOT NULL,
	`cycle` integer NOT NULL,
	`label` text NOT NULL,
	`start_seq` integer NOT NULL,
	`end_seq` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_stage_cycles`("id", "session_id", "workflow", "cycle", "label", "start_seq", "end_seq", "created_at") SELECT "id", "session_id", "workflow", "cycle", "label", "start_seq", "end_seq", "created_at" FROM `stage_cycles`;--> statement-breakpoint
DROP TABLE `stage_cycles`;--> statement-breakpoint
ALTER TABLE `__new_stage_cycles` RENAME TO `stage_cycles`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `stage_cycles_session_workflow_cycle_idx` ON `stage_cycles` (`session_id`,`workflow`,`cycle`);--> statement-breakpoint
ALTER TABLE `stage_spans` ADD `entries` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `stage_spans` DROP COLUMN `method`;