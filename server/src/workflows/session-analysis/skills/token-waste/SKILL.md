---
name: token-waste
description: Session-analysis stage for token waste — where tokens and cost went by stage, subagent and skill, then the avoidable part — oversized reads and outputs, unused large results, context snowball, unnecessary subagents, cache rebuilds after compaction, always-on skill descriptions.
---

# 浪费 token 的行为

先照 `session-analysis` skill 读过 `../session-analysis/references/` 的五份参考；证据、格式与归属以它们为准。输出：`output/findings-token-waste.json`。

关键词：**snowball**——上下文一路变大，每次请求都为之前的内容付钱。失败链的花费归 failures，重复的读取归 repeated-work；本阶段报告单次就过大或本不需要的消耗。

## 步骤

1. **账目。** 用每行的 `tokens` 与 `costUsd`（都是该请求的增量）算出：
   - 每个 session 的总花费、总输入（`input + cacheRead + cacheCreation`）与总输出；
   - 按阶段（`stages.json`）、按子代理、按 `attributionSkill` 的花费与占比；
   - 思考的 token：每行 `thinking` 各块 `tokens` 之和，按阶段的合计与占总输出的比例；
   - 花费最多的五个请求。

   这些数字写进相关发现的 detail；占总花费一成以上的部分必须出现在某条发现中。完成条件：`stages.json` 的每个阶段都有花费与占比。

2. **过大的结果。** 量出每个 tool 结果的大小（`result` 与 `spilledOutput` 的字符数，约 4 个字符一个 token），列出最大的十个。单个结果超过约 25,000 token，或读了整个大文件却只用到其中一小段（之后的回复与调用只涉及其中几行），各是一条发现。
3. **用不到的上下文。** 大结果（超过约 5,000 token）之后，回复与调用再也没有引用其中的内容。
4. **snowball。** 每次请求的总输入随 seq 的变化：找出持续增长、没有压缩或子代理分担的区段，写出起止 seq 与增长量。
5. **子代理。** 只做了一两步就能完成的事、结果没有被使用、或与主 agent 读了同样大量内容的子代理。
6. **压缩与缓存。** 上下文压缩（`notice`）的位置与次数；压缩之后 `cacheCreation` 的突增（缓存重建）；`cacheRead` 很少而 `cacheCreation` 很多的区段（缓存没有命中）。
7. **skill 的常驻成本。** `input/skills/` 中每个 skill 的 `description` 长度；session 中从未调用的 skill 也在每次请求中占着 description 的 token。
8. 按 `findings.md` 写出 `output/findings-token-waste.json` 并用 `jq .` 检查。
