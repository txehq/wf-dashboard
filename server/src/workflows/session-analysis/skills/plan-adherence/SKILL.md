---
name: plan-adherence
description: Session-analysis stage for plan adherence — recover the plan this task agreed to (ticket, acceptance criteria, Brief, plan file, checklist, confirmed design) and map every step to what was actually done.
---

# Plan adherence

First read the five references in `../session-analysis/references/` as the `session-analysis` skill says; they govern evidence, format and ownership. Output: `output/findings-plan-adherence.json`.

This stage looks only at this task's own plan; the general process the skills prescribe belongs to process-adherence, and whether the final artifacts meet the acceptance criteria belongs to output-quality. Keyword: **drift** — where execution leaves the plan.

## Steps

1. **Find the plan.** The plan is the approach this task settled on; check these sources in order:
   - the task in `run.json` (input, ticket, required checks); ticket bodies and acceptance criteria read in tool results;
   - plan-like files written in the session (Brief, Research, plan, Tickets, checklist: the tool calls that write or edit these files);
   - designs or steps the agent proposed before the user said "ok", "fine" or "go";
   - to-do records such as TodoWrite, and numbered steps in replies.

   Record the request and text of every step. When no plan can be found at all, that is the only finding (severity low), and detail says where you looked.

2. **Structural events.** Mark context compactions (`notice`), resumes, interruptions and subagent dispatches between plan and execution; a deviation right after one of them is a finding of its own.
3. **Step by step.** For each step of the plan, find the tool calls and replies that carry it out, or confirm there are none. Report:
   - skipped steps (quote the plan);
   - steps done out of order (give both seq);
   - silently changed steps: execution differs from the plan without the agent saying so (quote both sides);
   - extra work beyond the plan;
   - forgetting the original goal: later work unrelated to the initial goal.
4. Done when: every step of the plan is marked done, skipped, changed or not reached, and every piece of work beyond the plan is listed.
5. Write `output/findings-plan-adherence.json` as `findings.md` describes and check it with `jq .`.
