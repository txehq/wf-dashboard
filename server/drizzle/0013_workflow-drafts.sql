CREATE TABLE `workflow_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`workflow_id` text NOT NULL,
	`base_variant_id` text NOT NULL,
	`requirement` text NOT NULL,
	`live_id` text,
	`status` text DEFAULT 'open' NOT NULL,
	`saved_workflow_id` text,
	`saved_variant_id` text,
	`skills` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`base_variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
ALTER TABLE `live_sessions` ADD `engine` text DEFAULT 'claude' NOT NULL;--> statement-breakpoint
ALTER TABLE `variants` ADD `draft_id` text REFERENCES workflow_drafts(id);