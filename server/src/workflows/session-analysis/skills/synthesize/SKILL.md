---
name: synthesize
description: Final session-analysis stage, synthesize — merge all aspect findings, write the report (goal, outcome, counts, top issues, changes that need a new workflow) and skill patches for the analysed variant.
---

# Synthesis

First read the five references in `../session-analysis/references/` as the `session-analysis` skill says. The findings of the nine earlier stages are in `output/findings-<stage name>.json`, each already with an `id` (for example `failures-3`). The analyzed skills are in `input/skills/` (read-only). You write two files: `output/report.json` and `output/patches.json`. Do not raise new findings.

Sessions with the local machine configuration (`variant` in `input/case.json` is null) have no skills to change: write only `output/report.json`, not `output/patches.json`; in step 2, explain every finding that cannot become a patch in `topIssues`, write `[]` for `workflowChanges`, and skip steps 3 and 4.

## The line between variant and workflow

A workflow fixes only the entry skill and the stages (names, order, `repeatable`, `allowInside`; see `input/workflow.yaml`); as long as a variant has the entry skill and every stage's skill, the skills' content and any other skills and files are up to it.

- Changing only skill content (including adding skills or referenced files): **change the variant**, written as a patch in `patches.json`.
- Changing the entry, adding or removing stages, reordering them, changing `repeatable` or `allowInside`: **needs a new workflow**, written into `workflowChanges` in `report.json`, with no patch.

## Steps

1. **Read the findings.** Read all `output/findings-*.json`. Findings describing the same thing (same seq and same cause) count once: the finding of the stage that owns it in `boundaries.md` wins, and the others are listed with it when referenced.
2. **Decide where each one goes.** For each high and medium finding, judge whether changing a skill can solve or mitigate it:
   - yes: write a patch (step 3), or put it in `workflowChanges` (by the line above);
   - no (model capability, environment, external services): give the reason for not changing anything in the `impact` of a `topIssues` entry.

   Done when: every high finding appears in the `findingIds` of some patch or some `workflowChanges` entry, or in some `topIssues` entry.

3. **Write patches.** Each change targets specific findings and is small and precise: clarify a vague rule, remove a contradiction, add a missing step or check, delete a requirement that causes waste. Do not rewrite whole files, do not change content unrelated to the findings, and keep the original text's language and style. Only change existing files under `input/skills/` or create new files in a skill directory; do not delete files. Several patches to the same file must not change overlapping lines. How:
   1. `mkdir -p output/work/check && cp -R input/skills/. output/work/check/`, and edit a copy in `output/work/edit/<file>`;
   2. generate the patch with `diff -u` and change the two header lines to `--- a/<file>` and `+++ b/<file>` (`--- /dev/null` for a new file), with `<file>` relative to `input/skills/` (for example `ic/SKILL.md`);
   3. `cd output/work/check && git apply --check -p1 <patch file>` must pass. The dashboard runs the same check, and the whole stage fails when it does not pass.
4. **Write `output/patches.json`**: a JSON array, each element:
   ```json
   {
     "file": "ic/SKILL.md",
     "findingIds": ["failures-1"],
     "rationale": "Why change it this way and what it is expected to fix (in English)",
     "patch": "unified diff text"
   }
   ```
   When there is no change to write, write `[]`.
5. **Write `output/report.json`**:
   ```json
   {
     "summary": "Three to five sentences: what these sessions did, how they turned out, the main problems and their cost",
     "goal": "What the user wanted these sessions to achieve (only what the user stated explicitly)",
     "outcome": "achieved | partially_achieved | not_achieved | unclear",
     "topIssues": [
       {
         "title": "The problem",
         "findingIds": ["token-waste-2"],
         "impact": "Impact on time, tokens and cost, or the reason for not changing anything"
       }
     ],
     "workflowChanges": [
       {
         "findingIds": ["process-adherence-1"],
         "rationale": "Why the workflow needs to change",
         "change": "How to change the entry or the stages"
       }
     ]
   }
   ```
   `topIssues` goes from largest impact to smallest, at most five; write `[]` when there are none. Every `findingIds` value must be an id read in step 1; the dashboard checks this.
6. Confirm with `jq .` that the files you wrote (`output/report.json`, plus `output/patches.json` when there is a variant) are valid JSON, then finish.
