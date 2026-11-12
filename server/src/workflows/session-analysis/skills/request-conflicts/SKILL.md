---
name: request-conflicts
description: Session-analysis stage for request conflicts — places where the agent acted against an explicit earlier instruction from the user or a loaded instruction file (CLAUDE.md, AGENTS.md), instructions that contradict each other, and actions nobody asked for.
---

# Conflicts with requests

First read the five references in `../session-analysis/references/` as the `session-analysis` skill says; they govern evidence, format and ownership. Output: `output/findings-request-conflicts.json`.

Report only actions that go against an **earlier explicit request**; corrections without an earlier request belong to user-interaction, and the process the skills prescribe belongs to process-adherence. Do not judge whether the user is right; report only the conflict and how the agent handled it.

## Steps

1. **List the requests.** The explicit requests in each user message (must, do not, only, always, never, scope), and the rules of each instruction file in `instructions.json`, each with its location and text.
2. **Compare with the actions.** For each request, find later tool calls or replies that go against it (for example, told not to use an approach and used it, told to change only one place and changed others, a rule requiring A first and A skipped). Each is one finding: the evidence is the request that broke it, and the request's text goes in detail (the user message's seq, or the instruction file's path). Done when: every request has been checked.
3. **Contradictory requests.** Two requests that cannot both be met (user and user, user and instruction file, instruction file and skill), and how the agent handled them.
4. **Skips and changes.** What actually happened after the user asked to skip, ignore or change a step, a skill or a rule.
5. **Unauthorized actions.** Destructive or irreversible actions nobody asked for (deleting files or branches, force pushes, changing shared configuration, publishing externally).
6. Write `output/findings-request-conflicts.json` as `findings.md` describes and check it with `jq .`.
