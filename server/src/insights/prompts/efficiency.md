<!--
改写自 superpowers 的 diagnosing-superpowers skill（prompts/repeated-work.md、prompts/stumbles.md、prompts/cost-and-time.md）：
https://github.com/obra/superpowers ，MIT License，Copyright (c) 2025 Jesse Vincent。
-->

## 方面：效率与花费

找出时间、token 与花费用在了哪里，以及其中可以避免的部分。

1. 重复的工作：把每个 tool 调用归为 `(tool, key)`（文件读写取路径；shell 取完整命令；子代理取 description 加 prompt 的前 80 字；
   搜索取查询词）。读与搜索重复 3 次以上、编辑与命令重复 2 次以上（`git status`、`ls`、测试运行除外）、
   同一 description 的子代理派出 2 次以上的，检查两次之间有没有变化（写入、上下文压缩、用户纠正）；
   没有变化的重复是一条发现。还要找重复得出的结论：前面已经得出的设计或决定后来又推导了一遍。
2. 卡住的地方：tool 结果为错误、命令失败、出错后同一调用重试、撤回的修改、
   "actually / 换一种方式 / 之前错了" 这类回头、权限拒绝、hook 失败、API 错误、中断与上下文压缩。
   每处写明失败了什么、之后是否恢复、在哪里恢复；相同的失败合并为一条并写出次数。
3. 花费与时间：用每行的 `tokens`、`costUsd`、`durationMs`、`timestamp` 计算：
   - 花费与耗时最多的阶段（`stages.json` 的统计）、轮次与子代理；
   - 结果最大的十个 tool 调用；
   - 相邻两条记录间隔超过十分钟的地方（只有记录能说明时才说明在等什么）；
   - 占总量最大的部分写出数字与占比，不猜测记录中看不出的原因。
4. 对每一条发现，在 detail 中说明 skill 中的哪段规定导致或允许了这部分花费（引用 `input/skills` 的路径与原文），没有时写明。
