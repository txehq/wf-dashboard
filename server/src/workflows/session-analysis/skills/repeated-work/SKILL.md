---
name: repeated-work
description: Session-analysis stage for repeated work — reads, searches, edits, commands and subagents done more than once with nothing changing in between, re-reads after compaction, and conclusions derived twice.
---

# 重复的工作

先照 `session-analysis` skill 读过 `../session-analysis/references/` 的五份参考；证据、格式与归属以它们为准。输出：`output/findings-repeated-work.json`。

关键词：**rework**。失败之后的重试归 failures，轮询与状态检查归 time-waste，本阶段不报告。

## 步骤

1. **提取调用。** 把每个 tool 调用（主 agent 与子代理）写成 `(seq, agent, tool, key)`：
   | tool | key |
   |---|---|
   | 读、写、编辑文件 | 文件路径 |
   | shell | 完整命令（去掉末尾空白） |
   | 子代理（Agent、Task） | `description` 加 prompt 的前 80 个字符 |
   | 搜索（Grep、Glob、WebSearch、MCP 搜索） | 查询词与范围 |
   用 jq 生成这张表写进 `output/work/calls.jsonl`，之后的分组都从它计算。
2. **分组与阈值。** 按 `(tool, key)` 分组，报告达到阈值的组：
   | 类别 | 阈值 | 不算 |
   |---|---|---|
   | 读、搜索 | 3 次 | |
   | 编辑 | 2 次 | |
   | shell | 2 次 | `git status`、`ls`、`pwd`、测试运行 |
   | 子代理 | 同一 description 2 次 | |
   完成条件：每个达到阈值的组都已判定（下一步）。
3. **判定。** 对每个组，看两次之间发生了什么：
   - 有写入那个文件、用户纠正：正常，不是发现；
   - 有上下文压缩（`notice`）：是发现，归因于压缩；
   - 有失败：归 failures，跳过；
   - 什么都没有：是发现。
   每个发现写出次数、第一次与最后一次的 seq。
4. **重新推导。** 找回复与思考中再次得出前面已经得出的结论（同一个文件、同一个设计选择、同一条要运行的命令）；引用两处原文。
5. **重复的子代理。** 多个子代理做同一件事（prompt 的目标相同）、或子代理重做了主 agent 已经做过的工作。
6. 每条发现写出这些重复多花的 token 与花费（除第一次以外各次的请求之和，写算法）。
7. 按 `findings.md` 写出 `output/findings-repeated-work.json` 并用 `jq .` 检查。
