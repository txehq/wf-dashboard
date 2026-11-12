-- Stages are now cut linearly by Skill calls and slash commands: all old results are deleted and partitioned again on
-- read or import
DELETE FROM `stage_spans`;--> statement-breakpoint
DELETE FROM `stage_cycles`;--> statement-breakpoint
-- The stage-check model setting is gone
UPDATE `settings` SET `value` = json_remove(`value`, '$.models.stageCheck');
