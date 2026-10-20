---
name: process-adherence
description: Session-analysis stage for process adherence — whether the session went through the workflow's stages in order, fired the skills it should, and carried out the steps those skills require.
---

# 流程遵守

先照 `session-analysis` skill 读过 `../session-analysis/references/` 的五份参考；证据、格式与归属以它们为准。输出：`output/findings-process-adherence.json`。

本阶段只看 skill 与 workflow 的通用规定（`input/skills/`、`input/workflow.yaml`）；这次任务自己的计划归 plan-adherence。关键词：**drift**——实际走的路与 skill 规定的路分开的那一刻。

## 步骤

1. **阶段时间线。** 对每个 session，从 `stages.json` 列出每轮实际进入的阶段与起止 seq，与 `workflow.yaml` 的 `stages` 顺序对照。找出：被跳过的阶段、乱序进入的阶段、非 `repeatable` 的阶段重复进入、`allowInside` 之外的嵌套。完成条件：`workflow.yaml` 的每个阶段都标为进入、跳过或没有轮到（session 在它之前结束）。
2. **skill 时间线。** 按用户的每一轮输入，列出每次 skill 加载（`skillLoads`、`Skill` tool 调用、slash 命令）与 `attributionSkill` 的变化。对每一轮，比较用户的请求与 `input/skills/*/SKILL.md` frontmatter 的 `description`：报告该触发而没有触发的 skill（写明哪条 description 与请求相符）、晚了一轮或几轮才触发的 skill。完成条件：每一轮用户输入都核对过。
3. **规定的步骤。** 对每个被调用的 skill，读它的 `SKILL.md`，列出它要求的步骤与检查（先写 checklist、先跑测试、先 review、结束时调用下一个阶段的 skill 等）；对每一项，在它生效的请求范围内找执行它的 tool 调用。没有执行、执行顺序与规定不同、规定的结束条件没有满足就离开的，各是一条发现。完成条件：每个被调用的 skill 的每一项规定都标为执行、没有执行或不适用。
4. **skill 文件的使用。** 找出：`SKILL.md` 中引用的文件（`references/`、`scripts/`）在需要时没有读；同一个 skill 文件被反复读（说明内容该放进 SKILL.md）；只读了一部分（`head`、`offset`）就照着做；从未调用过的 skill。
5. **结束。** session 的最后几条请求：是否在 skill 规定的结束条件满足之前就结束（过早结束），或在结束条件满足之后还在继续。
6. 每条偏离的 detail 写明是 skill 写得不清楚、相互矛盾，还是 agent 没有照做，并引用 skill 原文。
7. 按 `findings.md` 写出 `output/findings-process-adherence.json` 并用 `jq .` 检查。
