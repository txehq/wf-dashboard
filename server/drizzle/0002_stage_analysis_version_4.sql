PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_stage_checks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`workflow` text NOT NULL,
	`version` integer DEFAULT 4 NOT NULL,
	`current_stage` text NOT NULL,
	`next_stage` text NOT NULL,
	`from_seq` integer NOT NULL,
	`to_seq` integer NOT NULL,
	`input_chars` integer NOT NULL,
	`entered` integer NOT NULL,
	`entered_at_seq` integer,
	`answer` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cost_usd` real NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_stage_checks`("id", "session_id", "workflow", "version", "current_stage", "next_stage", "from_seq", "to_seq", "input_chars", "entered", "entered_at_seq", "answer", "model", "input_tokens", "output_tokens", "cost_usd", "created_at") SELECT "id", "session_id", "workflow", "version", "current_stage", "next_stage", "from_seq", "to_seq", "input_chars", "entered", "entered_at_seq", "answer", "model", "input_tokens", "output_tokens", "cost_usd", "created_at" FROM `stage_checks`;--> statement-breakpoint
DROP TABLE `stage_checks`;--> statement-breakpoint
ALTER TABLE `__new_stage_checks` RENAME TO `stage_checks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `stage_checks_session_idx` ON `stage_checks` (`session_id`,`workflow`);