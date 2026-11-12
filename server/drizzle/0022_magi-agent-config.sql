DROP TABLE `magi_agent_current`;--> statement-breakpoint
ALTER TABLE `live_sessions` ADD `agent_config` text;--> statement-breakpoint
UPDATE `live_sessions` SET `agent_config` = 'local' WHERE `purpose` = 'agent';--> statement-breakpoint
UPDATE `live_sessions` SET `title` = 'New session' WHERE `purpose` = 'agent' AND `title` IN ('Magi Agent (Codex)', 'Magi Agent (Claude Code)');--> statement-breakpoint
UPDATE `live_sessions` SET `title` = substr((SELECT `title` FROM `sessions` WHERE `sessions`.`id` = `live_sessions`.`claude_session_id`), 1, 40) WHERE `purpose` = 'agent' AND `engine` = 'claude' AND `title` = 'New session' AND (SELECT `title` FROM `sessions` WHERE `sessions`.`id` = `live_sessions`.`claude_session_id`) IS NOT NULL;