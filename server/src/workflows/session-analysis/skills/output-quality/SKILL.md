---
name: output-quality
description: Session-analysis stage for output quality — the evidence behind the session's own claims — test runs, unverified "done" claims, tests changed to pass, commit messages, review comments and CI, grading results, and artifacts against what the skills require.
---

# 产物质量

先照 `session-analysis` skill 读过 `../session-analysis/references/` 的五份参考；证据、格式与归属以它们为准。输出：`output/findings-output-quality.json`。

这不是代码审查：不评价产出的代码本身，只核对过程自己的说法与证据。关键词：**unverified claim**。过程中失败又修好的归 failures。

## 步骤

1. **测试。** 每一次测试运行（命令中含 test、vitest、jest、pytest、cargo test、go test，或仓库说明中的测试命令）及其结果行；最后一次运行仍然失败的、失败后没有再运行就继续的，各是一条发现。
2. **声明背后的证据。** 找出回复中声称完成、通过、已修复、已验证、可以工作的地方；在同一轮中往前找证明它的 tool 结果（测试输出、命令输出、diff）。找不到的声明是一条发现。完成条件：每一处这样的声明都已核对。
3. **迁就测试。** 删除或修改测试、放宽断言、特判测试输入、跳过测试来让结果通过的修改。
4. **提交。** 每次 `git commit` 与它的提交信息，对照之前的 tool 调用：信息声称做了而实际没做的工作，做了却没有提交的工作。
5. **review 与 CI**（`run.json` 的 `pr`，以及 session 中 review、fix 类 skill 的结果）：提出了但没有处理的意见、没有给出理由就驳回的意见、最终仍失败的 check。
6. **评分**（只有 `run.json` 时）：rubric 每条的得分与理由、验收标准的得分、隐藏测试的通过情况、是否到达终点；每个失分的条目对应到造成它的请求，作为发现。
7. **产物与 skill 的要求。** Brief、Research、Tickets、PR 正文等产物是否满足 skill 中对它的要求（引用 skill 的规定与产物的原文）。
8. 按 `findings.md` 写出 `output/findings-output-quality.json` 并用 `jq .` 检查。
