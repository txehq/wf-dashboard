DROP INDEX `variants_workflow_name_idx`;--> statement-breakpoint
ALTER TABLE `variants` ADD `deleted_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `variants_workflow_name_idx` ON `variants` (`workflow_id`,`name`) WHERE "variants"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE `workflows` ADD `deleted_at` integer;