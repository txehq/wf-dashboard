---
name: failures
description: Session-analysis stage for failures — every point where the session stopped going forward (tool errors, failed commands, retries, loops, workarounds, getting stuck), whether and where it recovered, and what each failure chain cost.
---

# Where things keep failing

First read the five references in `../session-analysis/references/` as the `session-analysis` skill says; they govern evidence, format and ownership. Output: `output/findings-failures.json`.

Keywords: **stumble** (one failure) and **retry chain** (the run of requests from the first failure to recovery or giving up). Repetition and cost within a failure chain are reported only in this stage.

## Steps

1. **List every failure** (both main agent and subagents):
   - tool calls with `isError` true;
   - non-zero command exits, `command not found`, `No such file`, timeouts;
   - permission denials, hook failures, API errors, rate limits and quotas (`rate limit`, `quota`, `429`, `overloaded`);
   - reverted changes: an edit later changed back, or `git checkout`, `git restore`, `git reset` on a changed file;
   - backtracking in replies ("actually", "let me instead", "that was wrong", "try another way").

   Done when: every call with `isError` true belongs to some failure chain, or has a stated reason it can be ignored (for example an expected probe).

2. **Link into failure chains.** Starting from a failure, look forward for: the same action retried unchanged, retried with other arguments, a change of strategy, a detour (avoiding the problem another way), giving up. It is stuck when:
   - the same action and the same error appear 3 times;
   - the same action and the same result appear 4 times in a row;
   - two actions alternate (A-B-A-B) for more than 6 steps;
   - the same code keeps being changed while the test results stay the same.

   For each chain, give: start and end seq, what failed, what happened next (recovered in the same turn / recovered at seq N / did not recover), and whether a strategy change had a basis.

3. **Compute the cost.** For the requests each chain covers: the sum of `costUsd` and tokens, and the `timestamp` span (state the method).
4. **Classify.** Mark each chain's cause: environment (missing tool, missing credentials, external service unavailable or out of quota), caused by a skill's rule (quote it), or the agent's approach. Merge identical failures (same error text) into one finding with the count and all their seq.
5. Write `output/findings-failures.json` as `findings.md` describes and check it with `jq .`.
