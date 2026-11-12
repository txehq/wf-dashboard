# Example: hello-flow

A small workflow with one entry and three stages: it turns one sentence from the user into a short piece of writing. Follow its shape: each skill says only what to do and when to call the next stage's skill; review is a stage that waits for the user's reply.

## workflow.yaml

```yaml
id: hello-flow
name: Hello flow
stages:
  - id: gather
  - id: draft
  - id: review
    repeatable: true
```

## src/skills/hello-flow/SKILL.md

```markdown
---
name: hello-flow
description: Turns one sentence from the user into a short piece of writing. Use when the user types /hello-flow <topic>.
---

# /hello-flow

Go through three stages in order, calling each stage's skill when it starts:

1. `Skill(gather)`: find out what to write.
2. `Skill(draft)`: write the piece.
3. `Skill(review)`: check and revise until the user is satisfied.

Pass the topic the user typed to gather unchanged.
```

## src/skills/gather/SKILL.md

```markdown
---
name: gather
description: First stage of hello-flow — find out the piece's audience, length and tone.
---

# gather

Ask the user three things: who the audience is, how long it should be, and what tone. Ask them all at once, then end this turn and wait for the answers.

When all three have answers, call `Skill(draft)`.
```

## src/skills/draft/SKILL.md

```markdown
---
name: draft
description: Second stage of hello-flow — write the piece to the requirements gather collected.
---

# draft

Write the piece for the audience, length and tone, into `hello.md` in the current directory.

When done, call `Skill(review)`.
```

## src/skills/review/SKILL.md

```markdown
---
name: review
description: Last stage of hello-flow — check hello.md against the requirements, show the piece to the user, and revise it as the user asks.
---

# review

Check `hello.md` against the audience, length and tone, and fix whatever does not match.

Then output the whole piece to the user, ask whether they are satisfied, **end this turn**, and wait for the reply. Do not go on revising or call another skill in the same turn.

After the user replies:

- Changes requested: make them, call `Skill(review)` once (review is repeatable), output the whole piece again, and stop to wait for the reply.
- Satisfied: finish and report where `hello.md` is.
```
