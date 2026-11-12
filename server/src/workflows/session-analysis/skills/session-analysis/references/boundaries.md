# Which stage each behavior belongs to

Each behavior is reported by exactly one stage. Skip behaviors that belong to another stage; when one affects this stage's numbers, write "see <stage name>" in detail.

| Behavior                                                                                                                                                                                                                                                                                               | Owner             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| A stage skipped, out of order or entered repeatedly; a skill that should have triggered and did not, or triggered late; a skill called without carrying out the steps it prescribes; files a skill references not read or only partly read, the same skill file read again and again; ending too early | process-adherence |
| Steps of this task's own plan (ticket, acceptance criteria, Brief, plan, checklist, design the user confirmed) skipped, out of order, silently changed, or extra work beyond the plan; drift after compaction or resume; forgetting the original goal                                                  | plan-adherence    |
| Tool errors, failed commands, permission denials, hook failures, API errors and rate limits, timeouts; retries after an error, repeated edits without progress, detours, getting stuck; the time and tokens of the whole failure chain                                                                 | failures          |
| Repeated reads, searches, edits, commands and subagents with no failure in between; rereading after compaction; re-deriving conclusions already reached                                                                                                                                                | repeated-work     |
| Single reads or outputs that are too large, large results never used, token snowballing, unnecessary subagents, cache rebuilds after compaction, the standing cost of skill descriptions                                                                                                               | token-waste       |
| Waiting, polling, status checks, long durations other than timeouts, serial work that could run in parallel, thinking without acting                                                                                                                                                                   | time-waste        |
| Whether questions were necessary, concise and easy to answer, questions that should have been asked and were not; corrections, interruptions, nudges and dissatisfaction not caused by an earlier request; how long the user took to reply                                                             | user-interaction  |
| Test results, claims of completion without evidence, changing tests to fit the code, commit messages that do not match the changes, review comments and CI, grading point losses, artifacts that do not meet the skill's requirements                                                                  | output-quality    |
| Doing the opposite of the user's earlier explicit request or of an instruction file, contradictory requests, actions beyond what was authorized                                                                                                                                                        | request-conflicts |

Cases on the boundary:

- Retrying unchanged after a failure: failures (repeated-work does not report it).
- Polling and repeatedly checking status: time-waste (repeated-work does not report it).
- Tokens and time spent by a failure chain: counted only in failures.
- Tests or checks that still fail at the end: output-quality; those that failed along the way and were fixed: failures.
- The user correcting the agent: request-conflicts when the agent broke a request the user had stated explicitly before, otherwise user-interaction.
- Skipping a general step the skill prescribes: process-adherence; skipping a step of this task's plan: plan-adherence.
