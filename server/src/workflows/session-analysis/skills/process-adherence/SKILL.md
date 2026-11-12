---
name: process-adherence
description: Session-analysis stage for process adherence — whether the session went through the workflow's stages in order, fired the skills it should, and carried out the steps those skills require.
---

# Process adherence

First read the five references in `../session-analysis/references/` as the `session-analysis` skill says; they govern evidence, format and ownership. Output: `output/findings-process-adherence.json`.

This stage looks only at the general rules of the skills and the workflow (`input/skills/`, `input/workflow.yaml`); this task's own plan belongs to plan-adherence. Keyword: **drift** — the moment the path actually taken parts from the path the skills prescribe.

## Steps

1. **Stage timeline.** For each session, list from `stages.json` the stages actually entered in each cycle with their start and end seq, and compare them with the order of `stages` in `workflow.yaml`. Find: skipped stages, stages entered out of order, non-`repeatable` stages entered repeatedly, nesting outside `allowInside`. Done when: every stage of `workflow.yaml` is marked entered, skipped or not reached (the session ended before it).
2. **Skill timeline.** For each user input, list every skill load (`skillLoads`, `Skill` tool calls, slash commands) and every change of `attributionSkill`. For each turn, compare the user's request with the `description` in the frontmatter of `input/skills/*/SKILL.md`: report skills that should have triggered and did not (say which description matches the request), and skills that triggered one or more turns late. Done when: every user input has been checked.
3. **Prescribed steps.** For each skill called, read its `SKILL.md` and list the steps and checks it requires (write a checklist first, run tests first, review first, call the next stage's skill at the end, and so on); for each item, look for the tool calls that carry it out within the requests where the skill is in effect. Each item not carried out, carried out in a different order than prescribed, or left before its prescribed end condition was met is one finding. Done when: every rule of every skill called is marked carried out, not carried out or not applicable.
4. **Use of skill files.** Find: files referenced in `SKILL.md` (`references/`, `scripts/`) not read when needed; the same skill file read again and again (a sign its content belongs in SKILL.md); acting on a partial read (`head`, `offset`); skills never called.
5. **Ending.** The session's last few requests: did it end before the end condition the skill prescribes was met (ending too early), or keep going after it was met?
6. In the detail of each deviation, say whether the skill is unclear or contradictory, or the agent did not follow it, and quote the skill text.
7. Write `output/findings-process-adherence.json` as `findings.md` describes and check it with `jq .`.
