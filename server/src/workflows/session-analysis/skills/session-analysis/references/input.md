# input/ 的内容

全部只读。

- `input/case.json`：这次分析的范围：`analysisId`、`variant`（被分析的 variant 的 id 与名字；本机配置的 session 为 null，见文末）、`sessions`（每个 session 的 id、标题、cwd、runId、请求数与主 agent 请求数）。
- `input/workflow.yaml`：被分析 variant 所属 workflow 的定义：`id` 是入口命令与入口 skill 的名字，`stages` 是有顺序的小阶段（每个阶段一个同名 skill；`repeatable` 的阶段再次进入只记次数；`allowInside` 列出在本阶段中调用不算切换的阶段）。
- `input/skills/`：被分析 variant 的全部 skill（`<skill>/SKILL.md` 与它引用的文件）。detail 中引用 skill 原文时写这里的路径。
- `input/sessions/<sessionId>.jsonl`：每行是一次模型请求：
  - `seq`：请求序号。主 agent 的请求 `agent` 为 null，`seq` 即它在主 agent 中的序号；子代理的请求 `agent` 为子代理 id，`seq` 是它在子代理内的序号，`parentSeq` 是启动它的那条主 agent 请求的 `seq`（主 agent 的行 `parentSeq` 等于自己的 `seq`）。
  - `stage`：所属的 workflow 轮次与阶段（例如 `ic#1 implement`），不属于任何阶段时为 null。
  - `timestamp`、`durationMs`、`model`、`tokens`（`input` 未缓存的输入、`output`、`cacheRead`、`cacheCreation`，都是这一次请求的增量）、`costUsd`（这一次请求的花费）、`attributionSkill`（当时生效的 skill）。
  - `userMessagesBefore`：触发这条请求的用户消息与系统事件；`kind` 为 `user` 是用户（或评估 run 中的模拟用户）说的话，`notice` 是系统事件（例如上下文压缩、hook 输出），不是用户的话。
  - `skillLoads`：这条请求之前加载进上下文的 skill（名称与参数）。
  - `thinking`：模型思考的各个块，只有 `type`（`thinking` 或 `redacted_thinking`）与 `tokens`，不含思考的文字；没有思考时为 null。Claude Code 的 session 中 `tokens` 是估算数（这次请求的 `tokens.output` 减去回复文字与 tool 调用输入的估算数，由这次请求的各个块均分）；Codex 的 session 中是这次请求记录的推理 token 数，由各个块均分。
  - `text`：模型的回复文字。
  - `toolCalls`：每个 tool 调用的 `name`、完整 `input`、完整 `result`（不截断）、`isError`、`subagentId`；结果溢出到文件时 `spilledOutput` 是文件的完整内容。
- `input/sessions/<sessionId>/stages.json`：按 `workflow.yaml` 划分的阶段（每轮的各阶段、起止 seq、状态、请求数、token、花费、耗时）。
- `input/sessions/<sessionId>/conversation.json`：用户与 agent 的对话（用户消息、每轮最后的回复、AskUserQuestion 的问题与回答）。
- `input/sessions/<sessionId>/instructions.json`：session 中加载的指令文件（CLAUDE.md、AGENTS.md 等）：每项 `timestamp` 与 `files`（`path`、`type`、`content`）。没有加载时为空数组。
- `input/sessions/<sessionId>/run.json`（只有评估 run 的 session 才有）：task（不含隐藏需求与评分标准）、评分结果与理由、产物、模拟用户的对话、PR 的 review 与 CI（`pr`）。

## 本机配置的 session

`case.json` 的 `variant` 为 null 时，这些 session 来自用户本机的 Claude Code 或 Codex，不属于任何 workflow：没有 `input/skills/`、`input/workflow.yaml` 与 `stages.json`，每行的 `stage` 都是 null。每个阶段照常分析 session 本身（请求、tool 调用、对话、指令文件）；阶段中与 `input/skills/`、`workflow.yaml` 或阶段对照的步骤没有对象，跳过，不为此报告发现。detail 中引用的 skill 原文只能来自 session 中的 `skillLoads` 与 tool 结果。
