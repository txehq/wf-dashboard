ALTER TABLE `live_sessions` ADD `purpose` text DEFAULT 'interaction' NOT NULL;--> statement-breakpoint
-- Infer purpose and engine from existing records (Contracts 14.3): items with a draft are Codex sessions, optimize
-- drafts are optimize, other drafts are design
UPDATE `live_sessions` SET `purpose` = 'optimize', `engine` = 'codex' WHERE `id` IN (SELECT `live_id` FROM `workflow_drafts` WHERE `mode` = 'optimize' AND `live_id` IS NOT NULL);--> statement-breakpoint
UPDATE `live_sessions` SET `purpose` = 'design', `engine` = 'codex' WHERE `id` IN (SELECT `live_id` FROM `workflow_drafts` WHERE `mode` IN ('workflow', 'variant') AND `live_id` IS NOT NULL);
