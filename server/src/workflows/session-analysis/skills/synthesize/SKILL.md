---
name: synthesize
description: Final session-analysis stage, synthesize — merge all aspect findings, write the report (goal, outcome, counts, top issues, changes that need a new workflow) and skill patches for the analysed variant.
---

# 综合

先照 `session-analysis` skill 读过 `../session-analysis/references/` 的五份参考。前面九个阶段的发现在 `output/findings-<阶段名>.json`，每条已有 `id`（例如 `failures-3`）。被分析的 skill 在 `input/skills/`（只读）。你写两个文件：`output/report.json` 与 `output/patches.json`。不再提出新的发现。

## variant 与 workflow 的界限

workflow 只规定入口 skill 与小阶段（名字、顺序、`repeatable`、`allowInside`，见 `input/workflow.yaml`）；variant 只要有入口 skill 与每个小阶段的 skill，skill 的内容、其他 skill 与文件都由它自己决定。

- 只改 skill 的内容（包括新增 skill、新增引用的文件）：**改 variant**，写成 `patches.json` 中的 patch。
- 要改入口、增删小阶段、调整顺序、改 `repeatable` 或 `allowInside`：**需要新建 workflow**，写进 `report.json` 的 `workflowChanges`，不写 patch。

## 步骤

1. **读发现。** 读全部 `output/findings-*.json`。描述同一件事的发现（同样的 seq 与同样的原因）只算一次：以 `boundaries.md` 中归属的那个阶段的发现为准，其余在引用时一并列出。
2. **逐条定去处。** 对每条 high 与 medium 的发现，判断能不能通过改 skill 解决或缓解：
   - 能：写 patch（第 3 步），或写进 `workflowChanges`（按上面的界限）；
   - 不能（模型能力、环境、外部服务）：在 `topIssues` 的 `impact` 中写明不改的原因。
   完成条件：每条 high 的发现都出现在某个 patch 的 `findingIds`、某条 `workflowChanges` 的 `findingIds`，或某条 `topIssues` 中。
3. **写 patch。** 每处修改针对具体的发现，小而准确：澄清含糊的规定、消除矛盾、补上缺失的步骤或检查、删去导致浪费的要求。不重写整个文件，不改与发现无关的内容，保持原文的语言与写法。只改 `input/skills/` 下已有的文件或在某个 skill 目录中新建文件，不删除文件。同一个文件的多个 patch 不能修改重叠的行。做法：
   1. `mkdir -p output/work/check && cp -R input/skills/. output/work/check/`，在 `output/work/edit/<file>` 改一份副本；
   2. `diff -u` 生成 patch，把两行文件头改成 `--- a/<file>`、`+++ b/<file>`（新建文件时 `--- /dev/null`），`<file>` 相对 `input/skills/`（例如 `ic/SKILL.md`）；
   3. `cd output/work/check && git apply --check -p1 <patch 文件>` 必须通过。dashboard 会做同样的检查，不通过时整个阶段失败。
4. **写 `output/patches.json`**：JSON 数组，每个元素：
   ```json
   { "file": "ic/SKILL.md", "findingIds": ["failures-1"], "rationale": "为什么这样改、预期解决什么（中文）", "patch": "unified diff 文本" }
   ```
   没有可写的修改时写 `[]`。
5. **写 `output/report.json`**：
   ```json
   {
     "summary": "三到五句：这些 session 做了什么、结果如何、最主要的问题及其代价",
     "goal": "用户要这些 session 完成什么（只按用户明确提出的）",
     "outcome": "achieved | partially_achieved | not_achieved | unclear",
     "topIssues": [{ "title": "问题", "findingIds": ["token-waste-2"], "impact": "时间、token、花费的影响，或不改的原因" }],
     "workflowChanges": [{ "findingIds": ["process-adherence-1"], "rationale": "为什么需要改 workflow", "change": "要怎样改入口或小阶段" }]
   }
   ```
   `topIssues` 按影响从大到小，最多五条；没有时写 `[]`。所有 `findingIds` 必须是第 1 步读到的 id，dashboard 会检查。
6. 用 `jq . output/report.json output/patches.json` 确认两个文件都是合法的 JSON，然后结束。
