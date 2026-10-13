---
name: time-waste
description: Session-analysis stage for time waste — where wall-clock went by stage, the longest requests and gaps, then the avoidable part — waiting, polling, timeouts, long single calls, independent steps run serially, thinking without acting.
---

# 浪费时间的行为

先照 `session-analysis` skill 读过 `../session-analysis/references/` 的五份参考；证据、格式与归属以它们为准。输出：`output/findings-time-waste.json`。

关键词：**idle**——墙钟在走，工作没有往前。失败链的耗时归 failures；本阶段报告等待、轮询与串行。

## 步骤

1. **账目。** 用 `timestamp` 与 `durationMs` 算出：每个 session 的总时长；每个阶段（`stages.json`）的耗时与占比；最长的五个请求；相邻两条记录间隔超过十分钟的地方（只有记录能说明时才写在等什么：等用户、等子代理、等外部服务）。完成条件：`stages.json` 的每个阶段都有耗时与占比。
2. **等待与轮询。** `sleep`、反复查状态（同一个状态命令、`gh pr checks`、`gh run view`、读同一个日志的尾部）的次数、间隔与总耗时；后台任务的等待。
3. **长耗时的调用与超时。** 单个 tool 调用耗时很长的（从 tool_use 所在请求到下一条请求的间隔），超时与被中断的命令。
4. **串行。** 多个互不依赖的读取、搜索或命令分在连续的多次请求中，每次只发一个调用，本可以在一次请求中并行；写出可以合并的请求与估计节省的时间（这些请求的耗时之和减去其中最长的一个）。
5. **只想不做。** 很长的 thinking 或回复之后没有行动，或连续多条请求没有 tool 调用也没有用户输入。
6. 每条发现写出这部分花掉的时间（写算法）与 skill 中导致它的规定（例如要求轮询、要求逐个检查）。
7. 按 `findings.md` 写出 `output/findings-time-waste.json` 并用 `jq .` 检查。
