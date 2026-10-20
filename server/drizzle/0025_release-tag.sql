CREATE TABLE `workflow_releases` (
	`workflow_id` text PRIMARY KEY NOT NULL,
	`tag` text,
	`published_at` integer,
	`checked_at` integer NOT NULL,
	`error` text,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `variants` ADD `release_tag` text;