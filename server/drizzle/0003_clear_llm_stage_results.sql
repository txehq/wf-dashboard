-- 阶段改为按 Skill 调用与 slash 命令线性切块：旧的判定结果全部删除，读取或导入时重新划分
DELETE FROM `stage_spans`;--> statement-breakpoint
DELETE FROM `stage_cycles`;--> statement-breakpoint
-- 阶段判定模型的设置已取消
UPDATE `settings` SET `value` = json_remove(`value`, '$.models.stageCheck');
