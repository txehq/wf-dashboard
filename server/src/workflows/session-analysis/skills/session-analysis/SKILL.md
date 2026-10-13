---
name: session-analysis
description: Analyse coding-agent session transcripts exported in input/ — one aspect when given a stage name (process-adherence, plan-adherence, failures, repeated-work, token-waste, time-waste, user-interaction, output-quality, request-conflicts, synthesize), all aspects in order when given none.
---

# session 分析

当前目录是一次分析的目录：`input/` 是被分析的 session 与它们所用 variant 的 skill（只读），`output/` 是你唯一可以写的地方。你找出这个 variant 的 skill 在这些 session 中造成或放任的问题，每条都有原文证据。

## 步骤

1. 读这五份参考，全部读完再往下：
   - [`references/input.md`](references/input.md)：`input/` 的每个文件与字段。
   - [`references/context-safety.md`](references/context-safety.md)：读大文件的规则，每次读 `input/` 都遵守。
   - [`references/evidence.md`](references/evidence.md)：证据规则。dashboard 逐条校验，一条不合格整个阶段失败。
   - [`references/findings.md`](references/findings.md)：发现的 JSON 格式、severity 与 detail 的写法。
   - [`references/boundaries.md`](references/boundaries.md)：每种行为归哪个阶段报告。
2. 读 `input/case.json`，知道这次分析哪些 session、哪个 variant。
3. 按参数进入阶段：
   - 参数是一个阶段名：用 Skill 调用那个阶段的 skill，照它做完，结束。
   - 没有参数：按顺序逐个调用 `process-adherence`、`plan-adherence`、`failures`、`repeated-work`、`token-waste`、`time-waste`、`user-interaction`、`output-quality`、`request-conflicts`，最后 `synthesize`；每个阶段写完它的输出文件后再调用下一个。

完成条件：参数指定的阶段（或全部阶段）的输出文件已写出，并通过 `jq .`。

出处见 [`NOTICE.md`](NOTICE.md)。
