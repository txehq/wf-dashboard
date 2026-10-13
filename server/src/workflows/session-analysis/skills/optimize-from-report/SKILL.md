---
name: optimize-from-report
description: Improve a workflow from a session-analysis report — decide whether the fix is a new variant (skill content only) or a new workflow (entry or stages change), then make the change in optimize/.
---

# 按分析报告优化

当前目录是一次分析的目录。你读报告，判断该改 variant 还是新建 workflow，然后在 `optimize/` 中把改动做出来；用户在 dashboard 中点"保存"。

- `PLATFORM.md`：接入 dashboard 的说明、保存时的校验、variant 与 workflow 的界限。
- `output/report.json`：总结、目标与结果、影响最大的问题（`topIssues`）、需要新建 workflow 的建议（`workflowChanges`）。
- `output/findings-<阶段名>.json`：每个方面的发现与证据；`output/patches.json`：针对 skill 的修改建议（都属于改 variant）。
- `input/`：被分析的 session 与 skill（只读；session 的一行可能有几十万字符，先 `wc -lc` 量大小，再用 `jq` 取需要的字段）。
- `optimize/src/`：被分析 variant 的 `src/` 副本，你在这里改；`optimize/workflow.yaml`：它所属 workflow 的定义副本。

## 步骤

1. 读 `PLATFORM.md`、`output/report.json`、`output/patches.json`、`optimize/workflow.yaml`；需要细节时读对应的 `output/findings-*.json`。
2. **判断。** `report.json` 的 `workflowChanges` 中有针对 high 发现的建议、且你同意它时，新建 workflow；否则改 variant。把判断写进 `optimize/DECISION.md`：第一行只写 `variant` 或 `workflow`，之后写理由。
3. **改 variant**：
   1. 在 `optimize/src/skills/` 中应用 `output/patches.json` 的 patch：每个 patch 写成文件后在 `optimize/src/skills/` 中运行 `git apply -p1 <patch 文件>`；有理由不采用的 patch 在 `DECISION.md` 中写明。
   2. 再按发现做 patch 之外需要的修改。
   3. `optimize/workflow.yaml` 保持原样，一个字也不改（改了就会保存为新 workflow）。
4. **新建 workflow**：
   1. 改 `optimize/workflow.yaml`：新的 `id`（入口命令，不能与已有的 workflow 相同）、`name` 与小阶段。
   2. 让 `optimize/src/skills/` 中有入口 skill（与新 id 同名）与每个小阶段的同名 skill，删去或改名不再使用的阶段 skill。
5. 写 skill 时用 `.agents/skills/writing-for-agents` 的原则，用 `.agents/skills/skill-creator` 建结构。
6. **自查**（与保存时的校验相同）：入口与每个小阶段的 skill 目录都在 `optimize/src/skills/` 中；每个 `SKILL.md` 以 YAML frontmatter 开头，有 `name`（与目录名相同）与 `description`。
7. 完成条件：每条 high 的发现在 `optimize/DECISION.md` 中有去处（改了哪个文件，或为什么不改）。最后告诉用户：改动已在 `optimize/`，可以点"保存"。
