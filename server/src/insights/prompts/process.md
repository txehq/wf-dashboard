<!--
改写自 superpowers 的 diagnosing-superpowers skill（prompts/skill-timeline.md、prompts/plan-adherence.md）：
https://github.com/obra/superpowers ，MIT License，Copyright (c) 2025 Jesse Vincent。
-->

## 方面：流程遵守

判断 agent 是否按 `input/skills/` 中 skill 规定的流程工作。

1. skill 时间线：按用户的每一轮输入，列出每次 skill 加载（`skillLoads`、`Skill` tool 调用、slash 命令）
   与 `attributionSkill` 的变化，以及读取 `SKILL.md` 的调用。对照 `stages.json`，找出：
   - skill 规定应当进入、却没有进入的阶段（被跳过的阶段，引用 skill 中规定它的原文）；
   - 晚了一轮或几轮才调用的 skill；
   - 调用了 skill，却没有执行其中规定的步骤（例如规定先写 checklist、先跑测试、先 review）。
2. 计划遵守：找出 session 认定的计划（用户确认过的设计、写出的 Brief / Research / plan 文件、checklist、编号的步骤），
   把每一步对应到实际的 tool 调用，报告：
   - 被跳过的步骤；
   - 顺序被打乱的步骤；
   - 悄悄改变的步骤（执行与计划不同且 agent 没有说明）；
   - 计划之外多做的工作；
   - 上下文压缩、中断之后立即出现的偏离。
3. 对每一条偏离，在 detail 中引用 skill 中相关的规定（路径与原文），说明是 skill 写得不清楚、相互矛盾，还是 agent 没有遵守。
