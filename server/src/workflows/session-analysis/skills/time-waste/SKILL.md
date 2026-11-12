---
name: time-waste
description: Session-analysis stage for time waste — where wall-clock went by stage, the longest requests and gaps, then the avoidable part — waiting, polling, timeouts, long single calls, independent steps run serially, thinking without acting.
---

# Time waste

First read the five references in `../session-analysis/references/` as the `session-analysis` skill says; they govern evidence, format and ownership. Output: `output/findings-time-waste.json`.

Keyword: **idle** — the wall clock runs while the work does not move forward. The duration of failure chains belongs to failures; this stage reports waiting, polling and serial work.

## Steps

1. **Accounts.** From `timestamp` and `durationMs`, compute: each session's total duration; each stage's (`stages.json`) duration and share; the five longest requests; gaps of more than ten minutes between adjacent records (say what it was waiting for only when the records show it: the user, a subagent, an external service). Done when: every stage in `stages.json` has a duration and a share.
2. **Waiting and polling.** The count, interval and total duration of `sleep` and repeated status checks (the same status command, `gh pr checks`, `gh run view`, reading the tail of the same log); waiting for background tasks.
3. **Long calls and timeouts.** Single tool calls that took very long (the gap from the request with the tool_use to the next request), and commands that timed out or were interrupted.
4. **Serial work.** Several independent reads, searches or commands spread over consecutive requests with one call each, which could have run in parallel in one request; give the requests that could be merged and the estimated time saved (the sum of their durations minus the longest one).
5. **Thinking without acting.** Many thinking `tokens` or a long reply followed by no action, or several consecutive requests with neither tool calls nor user input.
6. Each finding gives the time this part took (with the method) and the skill rule that caused it (for example a required poll or a required one-by-one check).
7. Write `output/findings-time-waste.json` as `findings.md` describes and check it with `jq .`.
