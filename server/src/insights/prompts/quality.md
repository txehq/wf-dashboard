<!--
改写自 superpowers 的 diagnosing-superpowers skill（prompts/quality-evidence.md），并加上评分、review 意见与 CI：
https://github.com/obra/superpowers ，MIT License，Copyright (c) 2025 Jesse Vincent。
-->

## 方面：产物质量

对照过程自己的说法检查质量证据；这不是代码审查，不评价产出的代码本身。

1. 测试：每一次测试运行（命令中含 test、vitest、pytest、cargo test 等，或仓库说明中的测试命令）及其结果，
   报告失败的运行与之后 agent 做了什么。
2. 声明背后的验证：agent 声称完成、已修复、通过、已验证、可以工作的地方，在同一轮中往前找能证明它的 tool 结果；
   找不到的声明是一条发现。
3. 提交：每次 `git commit` 与它的提交信息，对照之前的 tool 调用，报告信息声称做了而实际没做的工作。
4. review 与 CI：`run.json` 中 PR 的 reviews、review thread、评论与 checks，以及 session 中 /review-pr、/fix-pr 的结果。
   报告提出了但没有处理的意见、没有给出理由就驳回的意见、最终仍失败的 check。
5. 评分：`run.json` 中的评分（rubric 每条的得分与理由、验收标准的得分、隐藏测试的通过情况、是否到达终点），
   失分的条目对应到 session 中造成它的请求，作为发现。没有 `run.json` 时跳过这一项。
6. 产物：Brief、Research、Tickets、PR 正文等产物是否满足 skill 中对它的要求（引用 skill 的规定与产物的原文）。
