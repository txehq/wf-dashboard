PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`engine` text NOT NULL,
	`model` text NOT NULL,
	`variant_id` text,
	`session_ids` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`steps` text NOT NULL,
	`cost_usd` real,
	`analysis_variant_id` text,
	`report` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`analysis_variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_analyses`("id", "engine", "model", "variant_id", "session_ids", "status", "error", "steps", "cost_usd", "analysis_variant_id", "report", "created_at", "ended_at") SELECT "id", "engine", "model", "variant_id", "session_ids", "status", "error", "steps", "cost_usd", "analysis_variant_id", "report", "created_at", "ended_at" FROM `analyses`;--> statement-breakpoint
DROP TABLE `analyses`;--> statement-breakpoint
ALTER TABLE `__new_analyses` RENAME TO `analyses`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `sessions` ADD `engine` text DEFAULT 'claude' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `archived_at` integer;--> statement-breakpoint
ALTER TABLE `sources` ADD `engine` text DEFAULT 'claude' NOT NULL;--> statement-breakpoint
-- Sessions of the local configuration are not bound to a variant (Contracts 25.4): clear existing automatic and manual
-- bindings. Local sessions belong to sources that are not variant directories
UPDATE `sessions` SET `variant_id` = NULL, `variant_binding` = NULL WHERE `variant_binding` IN ('auto', 'manual') AND `source_id` IN (SELECT `id` FROM `sources` WHERE `variant` IS NULL);