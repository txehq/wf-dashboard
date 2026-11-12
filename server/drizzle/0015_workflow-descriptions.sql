PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workflow_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`workflow_id` text NOT NULL,
	`name` text,
	`description` text,
	`base_variant_id` text,
	`requirement` text NOT NULL,
	`live_id` text,
	`status` text DEFAULT 'open' NOT NULL,
	`error` text,
	`steps` text DEFAULT '[]' NOT NULL,
	`saved_workflow_id` text,
	`saved_variant_id` text,
	`skills` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`base_variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_workflow_drafts`("id", "mode", "workflow_id", "name", "description", "base_variant_id", "requirement", "live_id", "status", "error", "steps", "saved_workflow_id", "saved_variant_id", "skills", "created_at") SELECT "id", "mode", "workflow_id", "name", NULL, "base_variant_id", "requirement", "live_id", "status", "error", "steps", "saved_workflow_id", "saved_variant_id", "skills", "created_at" FROM `workflow_drafts`;--> statement-breakpoint
DROP TABLE `workflow_drafts`;--> statement-breakpoint
ALTER TABLE `__new_workflow_drafts` RENAME TO `workflow_drafts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `variants` ADD `description` text;--> statement-breakpoint
ALTER TABLE `workflows` ADD `description` text;--> statement-breakpoint
ALTER TABLE `workflows` DROP COLUMN `copied_from`;--> statement-breakpoint
-- Only the built-in lfg and ic have an eval kind (Contracts 16.1, 18.5)
UPDATE `workflows` SET `eval_kind` = NULL WHERE `id` NOT IN ('lfg', 'ic');