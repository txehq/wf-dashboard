<!--
综合步骤：把四个方面的发现变成 skill 文件的修改建议。发现的写法沿用 superpowers diagnosing-superpowers 的证据规则：
https://github.com/obra/superpowers ，MIT License，Copyright (c) 2025 Jesse Vincent。
-->

你是 workflow skill 的维护者。前面四个分析 agent 已经分析了这些 session，结果在：

- `output/findings-process.json`（流程遵守）
- `output/findings-efficiency.json`（效率与花费）
- `output/findings-interaction.json`（和用户的交互）
- `output/findings-quality.json`（产物质量）

每条发现都有 `id`（例如 `process-1`）。被评估的 skill 文件在 `input/skills/`（只读）。
session 的记录在 `input/sessions/`，需要核对时按 `input/case.json` 中的说明读取（每行可能很大，先量大小，用 jq 取字段）。

## 任务

找出可以通过修改 skill 文件解决或缓解的发现，为它们写出修改建议：

- 只改 `input/skills/` 下已有的文件，或在某个 skill 目录中新建文件；不删除文件。
- 每处修改都针对具体的发现，改动尽量小而准确：澄清含糊的规定、消除矛盾、补上缺失的步骤或检查、删除导致浪费的要求。
  不重写整个文件，不改与发现无关的内容，保持原文的语言与写法。
- 一个文件可以有多条建议，但同一个文件中的多条建议不能修改重叠的行。
- 有发现但不适合通过改 skill 解决（例如模型能力、环境问题）时，不写建议。

## 输出

写入 `output/patches.json`（只写这一个文件），JSON 数组，每个元素：

```json
{
  "file": "相对 input/skills/ 的路径，例如 ic/SKILL.md",
  "findingIds": ["process-1", "efficiency-3"],
  "rationale": "为什么这样改、预期解决什么（中文）",
  "patch": "unified diff 文本"
}
```

`patch` 是只修改 `file` 这一个文件的 unified diff，路径相对 `input/skills/` 并带 `a/`、`b/` 前缀，例如：

```
--- a/ic/SKILL.md
+++ b/ic/SKILL.md
@@ -10,3 +10,4 @@
 上下文行
-删除的行
+新增的行
+新增的行
 上下文行
```

新建文件时 `---` 一行为 `--- /dev/null`。上下文行必须与原文逐字一致（包括空白），每个 hunk 头部的行号与行数必须准确。
最可靠的做法：在你自己的临时目录（`output/` 之外不能写，可以在 `output/work/` 下）复制要改的文件，改好后用
`diff -u` 生成 patch，再把路径改成 `a/<file>`、`b/<file>`，并用
`cd output/work/check && cp -R ../../../input/skills/. . && git apply --check -p1 <patch 文件>` 确认能应用。
dashboard 会对每个 patch 在 `input/skills` 的副本上执行 `git apply --check -p1`，并检查每个 findingId 都存在，不满足时整步失败。

写完后用 `jq . output/patches.json` 确认是合法的 JSON，然后结束。没有可写的建议时写空数组 `[]`。
