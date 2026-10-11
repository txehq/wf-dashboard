CREATE TABLE `analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`engine` text NOT NULL,
	`model` text NOT NULL,
	`variant_id` text NOT NULL,
	`session_ids` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`steps` text NOT NULL,
	`cost_usd` real,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `analysis_findings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`analysis_id` text NOT NULL,
	`finding_id` text NOT NULL,
	`aspect` text NOT NULL,
	`title` text NOT NULL,
	`stage` text,
	`skill` text,
	`severity` text NOT NULL,
	`detail` text NOT NULL,
	`evidence` text NOT NULL,
	FOREIGN KEY (`analysis_id`) REFERENCES `analyses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analysis_findings_analysis_finding_idx` ON `analysis_findings` (`analysis_id`,`finding_id`);--> statement-breakpoint
CREATE TABLE `analysis_patches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`analysis_id` text NOT NULL,
	`file` text NOT NULL,
	`finding_ids` text NOT NULL,
	`rationale` text NOT NULL,
	`patch` text NOT NULL,
	FOREIGN KEY (`analysis_id`) REFERENCES `analyses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `analysis_patches_analysis_idx` ON `analysis_patches` (`analysis_id`);--> statement-breakpoint
CREATE TABLE `session_skill_scans` (
	`session_id` text PRIMARY KEY NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `session_skills` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`agent_id` text,
	`uuid` text NOT NULL,
	`name` text NOT NULL,
	`base_dir` text NOT NULL,
	`text` text NOT NULL,
	`args` text NOT NULL,
	`timestamp` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_skills_session_uuid_idx` ON `session_skills` (`session_id`,`uuid`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `variant_id` text REFERENCES variants(id);--> statement-breakpoint
ALTER TABLE `sessions` ADD `variant_binding` text;--> statement-breakpoint
CREATE INDEX `sessions_variant_idx` ON `sessions` (`variant_id`);--> statement-breakpoint
ALTER TABLE `variants` ADD `analysis_id` text REFERENCES analyses(id);--> statement-breakpoint
ALTER TABLE `variants` ADD `source_session_id` text;