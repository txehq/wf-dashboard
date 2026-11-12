# Workflows and variants in the dashboard

## The workflow definition

One entry command plus an ordered list of stages, written in `workflow.yaml`:

```yaml
id: hello-flow # entry command /hello-flow, also the name of the entry skill
name: Hello flow
stages: # stages; each name is a skill name
  - id: gather
  - id: draft
  - id: review
    repeatable: true # entering again only counts, it is not a new cycle
    allowInside: [draft] # calling draft inside review does not switch stages
```

- The entry skill has the workflow id as its name: `src/skills/hello-flow/SKILL.md`, called when the user types `/hello-flow <question>`. Each stage is a skill with the same name: `src/skills/gather/SKILL.md`, and so on.
- A single-skill workflow: its only stage has the workflow id as its name, and the entry itself is that stage (`stages: [{ id: hello-flow }]`).
- At the start of each stage the agent calls the matching Skill (`Skill(gather)`). The dashboard splits stages only by these calls: a stage runs from its call until the next stage's call, so every skill must say which stage's skill it calls when it ends.
- Stages advance in the defined order; calling an earlier stage, or calling the current stage again, starts a new cycle. A `repeatable` stage that calls itself again stays in the current cycle (a repair loop); a stage listed in `allowInside` does not switch stages when called from inside this one (for example, rerunning checks after a repair).
- Ids use only lowercase letters, digits and hyphens, starting with a letter. When you change the stages, add, remove or rename the matching directories in `src/skills/` the same way.
- Example: [`example-workflow.md`](example-workflow.md), one entry plus three stages; follow its shape.

## Stages that wait for the user's reply

When a stage needs the user's reply (showing the user a draft, asking the user to review), write the skill as "Output ..., then end this turn and wait for the user's reply; after the user replies, call `Skill(next stage)`". When the next stage is called in the same turn, what the user is meant to see stays only in your thinking. See the review stage in `example-workflow.md`.

## The line between variant and workflow

- A workflow fixes only the entry skill and the stages (names, order, `repeatable`, `allowInside`).
- A variant that has this workflow's entry skill and every stage's skill is a valid instance; the skills' content and any other skills and files are up to the variant.
- Changing only skill content (including adding skills or files) changes the variant, and `workflow.yaml` stays as it is; changing the entry or the stages means a new workflow.

## What the dashboard does at save time

The user clicks "Save" in the dashboard. The checks run in order; if any step fails, the user gets the original message, the draft is kept, and work can continue:

1. New workflow: `workflow.yaml` has the structure above, and no other workflow uses the id.
2. The entry skill and every stage's skill are in `src/skills/`; every `SKILL.md` starts with YAML frontmatter, `name` equals the directory name, and `description` is not empty.
3. Saving does not build; the user builds later on the variant page. There are two kinds of build, and PLATFORM.md says which one applies this time:
   - **wf** (built-in lfg and ic): `src/` is a full txe-workflow export; add, remove and change only in `src/skills/<name>/` and leave every other file as it is. At build time the dashboard registers added skills in `src/workflow/registry.yaml`, `src/docs/index.yaml` and `src/docs/product/features/` (and removes deleted ones from them; you do not change these files), then runs `wf guard`, `wf release build-local` and the install, and `wf status` exits 0.
   - **dashboard** (other workflows): `src/skills/` is everything, with no lists to maintain. Every directory in `src/skills/` needs a valid `SKILL.md`. At build time they are copied as-is into the variant's own Claude Code config directory; the user can also install them on this machine from the variant page.

## Trial run

Skills in `src/skills/` are installed into this session's own configuration as you write them, and deleted ones are removed too; skills with the same name as this session's skills (this skill, writing-for-agents, skill-creator, find-skills) are not installed. Once the entry and stages are written, type `/<entry> <question>` in this terminal to try it, or call the entry skill yourself and run it through, checking that each stage proceeds as written and stops where it waits for the user.

- Publishing stages (sending messages, writing tickets, opening PRs, writing into the vault or other directories) stop before publishing, show the user what would be published, and state where a real run would write it. Read-only queries run as usual.
- Files the trial run produces go into `trial/` in the working directory.
- After `src/mcp.json` changes it loads only after a resume; ask the user to resume before the trial run.
