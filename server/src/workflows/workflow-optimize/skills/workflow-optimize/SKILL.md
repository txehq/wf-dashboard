---
name: workflow-optimize
description: Improve a workflow from a session-analysis report — decide whether the fix is a new variant (skill content only) or a new workflow (entry or stages change), then make the change in optimize/. Use when the user types /workflow-optimize.
---

# /workflow-optimize

The current directory is the directory of one analysis. You read the report, decide whether to change the variant or create a new workflow, then make the change in `optimize/`; the user clicks "Save" in the dashboard.

- `PLATFORM.md`: the facts of this session (the analysis, the analyzed variant and workflow, the build method, the paths, and the MCP servers this session loads).
- `output/report.json`: the summary, goals and results, the most impactful issues (`topIssues`), and suggestions that need a new workflow (`workflowChanges`).
- `output/findings-<stage>.json`: each aspect's findings and evidence; `output/patches.json`: suggested skill changes (all of them change the variant).
- `input/`: the analyzed sessions and skills (read-only; one session line can be hundreds of thousands of characters, so measure with `wc -lc` first, then take the fields you need with `jq`).
- `optimize/src/`: a copy of the analyzed variant's `src/`, which you change here; `optimize/workflow.yaml`: a copy of the definition of the workflow it belongs to. `src/` and `workflow.yaml` in [`workflow-rules.md`](workflow-rules.md) mean these two here.

## Steps

1. Read `PLATFORM.md`, [`workflow-rules.md`](workflow-rules.md), `output/report.json`, `output/patches.json` and `optimize/workflow.yaml`; read the matching `output/findings-*.json` when you need details.
2. **Decide.** Create a new workflow when `workflowChanges` in `report.json` has a suggestion for a high finding and you agree with it; otherwise change the variant. Write the decision into `optimize/DECISION.md`: the first line is only `variant` or `workflow`, followed by the reasons. At save time the dashboard compares `optimize/workflow.yaml` with the original workflow's definition: if they are the same it saves a new variant of the original workflow, if they differ it saves a new workflow and its first variant.
3. **Change the variant**:
   1. Apply the patches of `output/patches.json` in `optimize/src/skills/`: write each patch to a file, then run `git apply -p1 <patch file>` in `optimize/src/skills/`; for a patch you have reasons not to apply, write them in `DECISION.md`.
   2. Then make the changes the findings need beyond the patches.
   3. Leave `optimize/workflow.yaml` exactly as it is; do not change a single character.
4. **Create a new workflow**:
   1. Change `optimize/workflow.yaml`: a new `id` (the entry command, which must differ from every existing workflow), `name` and stages.
   2. Make sure `optimize/src/skills/` has the entry skill (named like the new id) and a skill named like each stage, and delete or rename the skills of stages no longer used.
5. Write skills by the principles of writing-for-agents and build their structure with skill-creator (both are installed in the same skill directory as this skill); when the change uses MCP servers, read [`mcp.md`](mcp.md) (`src/mcp.json` is `optimize/src/mcp.json` here).
6. **Check your work** (the same checks as the save): the skill directories of the entry and every stage are in `optimize/src/skills/`; every `SKILL.md` starts with YAML frontmatter that has `name` (equal to the directory name) and `description`.
7. Done when: every high finding has an outcome in `optimize/DECISION.md` (which file changed, or why it is not changed). Finally tell the user: the changes are in `optimize/`, and they can click "Save".
