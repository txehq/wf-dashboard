---
name: workflow-design
description: Writes all the skills of a new workflow, or a new variant of an existing workflow, in a dashboard draft directory from the user's requirement. Use when the user types /workflow-design <requirement>.
---

# /workflow-design

The current directory is a dashboard draft directory. You write skills here; when the user clicks "Save" in the dashboard, they get a new workflow, or a new variant of an existing workflow. The user's requirement is in the arguments.

## Steps

1. Read `PLATFORM.md` in the working directory: the facts of this session — the mode (new workflow or new variant), the workflow id, the base variant, the build method (wf or dashboard), the paths, and the MCP servers this session loads. From then on, use the paths it gives.
2. Read [`workflow-rules.md`](workflow-rules.md) (workflow structure, how stages are split, the checks at save time, trial runs) and [`example-workflow.md`](example-workflow.md), then read `workflow.yaml` and the existing skills in `src/skills/`.
3. Work according to the mode:
   - **New workflow**: `src/skills/` holds skeletons for the entry and each stage. First settle the stages (one job per stage, when to move to the next, where to wait for the user's reply) and write them into `workflow.yaml`, then write the entry and every stage as complete skills; when you add, remove or rename a stage, add, remove or rename its skill directory too.
   - **New variant**: `workflow.yaml` is read-only and the entry and stages are fixed. Change only the content of the skills in `src/skills/` (you may add skills and files) so that they meet the requirement.
4. Write skills by the principles of writing-for-agents (short, only what the agent does not know) and build their structure with skill-creator; when you need an existing skill, search with find-skills and install it at project scope (no `-g`) into this session's skill directory (PLATFORM.md says which one); to make it part of the workflow, copy it into `src/skills/`. These three skills are in the same skill directory as this skill.
5. When the workflow reads or writes external systems, read [`mcp.md`](mcp.md).
6. Where the user has to decide (how to split the stages, which external system to use, whether keys are needed), list all the questions at once and end this turn to wait for the user's answers.
7. Check your work the same way the save does: the entry skill and every stage's skill are in `src/skills/`; every `SKILL.md` starts with YAML frontmatter, `name` equals the directory name, and `description` is not empty; when the build method is dashboard, every directory in `src/skills/` has a valid `SKILL.md`. When a trial run is possible, run one as described under "Trial run" in workflow-rules.md.
8. Done when: every item of the requirement is written into some skill and the check passes. Finally tell the user which skills you changed and the trial run's result, and that they can click "Save".
