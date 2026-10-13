ALTER TABLE `live_sessions` ADD `purpose` text DEFAULT 'interaction' NOT NULL;--> statement-breakpoint
-- 按已有记录推出用途与引擎（Contracts 14.3）：有草稿的项是 Codex 会话，optimize 草稿为优化，其余草稿为设计
UPDATE `live_sessions` SET `purpose` = 'optimize', `engine` = 'codex' WHERE `id` IN (SELECT `live_id` FROM `workflow_drafts` WHERE `mode` = 'optimize' AND `live_id` IS NOT NULL);--> statement-breakpoint
UPDATE `live_sessions` SET `purpose` = 'design', `engine` = 'codex' WHERE `id` IN (SELECT `live_id` FROM `workflow_drafts` WHERE `mode` IN ('workflow', 'variant') AND `live_id` IS NOT NULL);
