ALTER TABLE `analyses` ADD `analysis_variant_id` text REFERENCES variants(id);--> statement-breakpoint
ALTER TABLE `analyses` ADD `report` text;--> statement-breakpoint
ALTER TABLE `workflow_drafts` ADD `analysis_id` text REFERENCES analyses(id);