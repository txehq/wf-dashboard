---
name: session-analysis
description: Analyse coding-agent session transcripts exported in input/ — one aspect when given a stage name (process-adherence, plan-adherence, failures, repeated-work, token-waste, time-waste, user-interaction, output-quality, request-conflicts, synthesize), all aspects in order when given none.
---

# Session analysis

The current directory is the directory of one analysis: `input/` holds the analyzed sessions and the skills of the variant they used (read-only), and `output/` is the only place you may write. You find the problems that this variant's skills caused or allowed in these sessions, each backed by verbatim evidence. Sessions with the local machine configuration have no variant (`variant` in `input/case.json` is null); for them you find the problems of the sessions themselves, as described in the last section of `references/input.md`.

## Steps

1. Read these five references, all of them, before going on:
   - [`references/input.md`](references/input.md): every file and field in `input/`.
   - [`references/context-safety.md`](references/context-safety.md): rules for reading large files; follow them every time you read `input/`.
   - [`references/evidence.md`](references/evidence.md): evidence rules. The dashboard checks every item, and one invalid item fails the whole stage.
   - [`references/findings.md`](references/findings.md): the JSON format of findings and how to write severity and detail.
   - [`references/boundaries.md`](references/boundaries.md): which stage reports each kind of behavior.
2. Read `input/case.json` to learn which sessions and which variant this analysis covers.
3. Enter stages according to the argument:
   - The argument is a stage name: call that stage's skill with Skill, do what it says, and finish.
   - No argument: call `process-adherence`, `plan-adherence`, `failures`, `repeated-work`, `token-waste`, `time-waste`, `user-interaction`, `output-quality`, `request-conflicts` one by one in this order, and finally `synthesize`; call the next stage only after the current one has written its output file.

Done when: the output files of the stage given by the argument (or of all stages) are written and pass `jq .`.

Sources are in [`NOTICE.md`](NOTICE.md).
