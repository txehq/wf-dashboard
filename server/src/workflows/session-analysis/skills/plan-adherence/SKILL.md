---
name: plan-adherence
description: Session-analysis stage for plan adherence — recover the plan this task agreed to (ticket, acceptance criteria, Brief, plan file, checklist, confirmed design) and map every step to what was actually done.
---

# 计划遵守

先照 `session-analysis` skill 读过 `../session-analysis/references/` 的五份参考；证据、格式与归属以它们为准。输出：`output/findings-plan-adherence.json`。

本阶段只看这次任务自己的计划；skill 规定的通用流程归 process-adherence，最终产物是否达到验收标准归 output-quality。关键词：**drift**——执行离开计划的地方。

## 步骤

1. **找到计划。** 计划是这次任务认定的做法，来源依次查：
   - `run.json` 的 task（输入、工单、required checks）；tool 结果中读到的工单正文与验收标准；
   - session 中写出的计划类文件（Brief、Research、plan、Tickets、checklist：写入或编辑这些文件的 tool 调用）；
   - 用户说"好""可以""go"之前 agent 提出的设计或步骤；
   - TodoWrite 之类的待办记录、回复中编号的步骤。
   每一步记下它所在的请求与原文。没有任何可找到的计划时，这就是唯一的一条发现（severity low），detail 写明查过哪些地方。
2. **结构事件。** 标出计划与执行之间的上下文压缩（`notice`）、resume、中断与派出子代理的请求；紧跟其后的偏离单独成一条发现。
3. **逐步对应。** 对计划的每一步，找执行它的 tool 调用与回复，或确认没有。报告：
   - 跳过的步骤（引用计划原文）；
   - 乱序执行的步骤（写出两者的 seq）；
   - 悄悄改变的步骤：执行与计划不同，agent 没有说明（引用两边）；
   - 计划之外多做的工作；
   - 忘记原目标：后期的工作与最初的目标无关。
4. 完成条件：计划的每一步都标为执行、跳过、改变或没有轮到；每一处计划外的工作都已列出。
5. 按 `findings.md` 写出 `output/findings-plan-adherence.json` 并用 `jq .` 检查。
