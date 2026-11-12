# What input/ contains

Everything is read-only.

- `input/case.json`: the scope of this analysis: `analysisId`, `variant` (id and name of the analyzed variant; null for sessions with the local machine configuration, see the end), `sessions` (each session's id, title, cwd, runId, request count and main agent request count).
- `input/workflow.yaml`: the definition of the workflow the analyzed variant belongs to: `id` is the entry command and the name of the entry skill, `stages` are the ordered stages (one skill of the same name per stage; entering a `repeatable` stage again only counts; `allowInside` lists the stages whose calls inside this stage are not a switch).
- `input/skills/`: all skills of the analyzed variant (`<skill>/SKILL.md` and the files it references). When detail quotes skill text, write the path here.
- `input/sessions/<sessionId>.jsonl`: each line is one model request:
  - `seq`: request number. For main agent requests `agent` is null and `seq` is the number within the main agent; for subagent requests `agent` is the subagent id, `seq` is the number within the subagent, and `parentSeq` is the `seq` of the main agent request that started it (on main agent lines `parentSeq` equals its own `seq`).
  - `stage`: the workflow cycle and stage it belongs to (for example `ic#1 implement`), null when it belongs to no stage.
  - `timestamp`, `durationMs`, `model`, `tokens` (`input` uncached input, `output`, `cacheRead`, `cacheCreation`, all increments of this request), `costUsd` (the cost of this request), `attributionSkill` (the skill in effect at the time).
  - `userMessagesBefore`: the user messages and system events that triggered this request; `kind` `user` is what the user (or the simulated user in an eval run) said, `notice` is a system event (for example context compaction, hook output) and not the user's words.
  - `skillLoads`: skills loaded into context before this request (name and arguments).
  - `thinking`: the model's thinking blocks, with only `type` (`thinking` or `redacted_thinking`) and `tokens`, without the thinking text; null when there was no thinking. In Claude Code sessions `tokens` is an estimate (this request's `tokens.output` minus the estimates of the reply text and tool call inputs, split evenly across the request's blocks); in Codex sessions it is the reasoning token count recorded for this request, split evenly across the blocks.
  - `text`: the model's reply text.
  - `toolCalls`: each tool call's `name`, full `input`, full `result` (not truncated), `isError` and `subagentId`; when the result spilled into a file, `spilledOutput` is the file's full content.
- `input/sessions/<sessionId>/stages.json`: the stages split by `workflow.yaml` (each cycle's stages, start and end seq, status, request count, tokens, cost, duration).
- `input/sessions/<sessionId>/conversation.json`: the conversation between the user and the agent (user messages, the last reply of each turn, AskUserQuestion questions and answers).
- `input/sessions/<sessionId>/instructions.json`: instruction files loaded in the session (CLAUDE.md, AGENTS.md and so on): each entry has `timestamp` and `files` (`path`, `type`, `content`). An empty array when none were loaded.
- `input/sessions/<sessionId>/run.json` (only for sessions of eval runs): the task (without hidden requirements and rubric), the grading results and reasons, artifacts, the simulated user's conversation, and the PR's review and CI (`pr`).

## Sessions with the local machine configuration

When `variant` in `case.json` is null, these sessions come from the user's local Claude Code or Codex and belong to no workflow: there is no `input/skills/`, `input/workflow.yaml` or `stages.json`, and every line's `stage` is null. Each stage analyzes the sessions themselves as usual (requests, tool calls, conversation, instruction files); steps that compare against `input/skills/`, `workflow.yaml` or stages have nothing to compare with, so skip them and report no findings for that. Skill text quoted in detail can only come from `skillLoads` and tool results in the sessions.
