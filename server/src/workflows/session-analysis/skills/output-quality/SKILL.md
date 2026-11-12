---
name: output-quality
description: Session-analysis stage for output quality — the evidence behind the session's own claims — test runs, unverified "done" claims, tests changed to pass, commit messages, review comments and CI, grading results, and artifacts against what the skills require.
---

# Output quality

First read the five references in `../session-analysis/references/` as the `session-analysis` skill says; they govern evidence, format and ownership. Output: `output/findings-output-quality.json`.

This is not a code review: do not judge the produced code itself; only check the process's own claims against the evidence. Keyword: **unverified claim**. Things that failed along the way and were fixed belong to failures.

## Steps

1. **Tests.** Every test run (commands containing test, vitest, jest, pytest, cargo test, go test, or the test command in the repository's instructions) and its result lines; a last run that still fails, and moving on after a failure without running again, are one finding each.
2. **Evidence behind claims.** Find places in replies that claim something is done, passing, fixed, verified or working; look back within the same turn for the tool result that proves it (test output, command output, diff). A claim without one is a finding. Done when: every such claim has been checked.
3. **Bending the tests.** Changes that delete or modify tests, loosen assertions, special-case test inputs or skip tests to make results pass.
4. **Commits.** Each `git commit` and its message, compared with the tool calls before it: work the message claims but that was not done, and work done but not committed.
5. **Review and CI** (`pr` in `run.json`, and the results of review and fix skills in the session): comments raised and not handled, comments dismissed without a reason, checks still failing at the end.
6. **Grading** (only when there is a `run.json`): each rubric item's score and reason, the acceptance criteria scores, the hidden tests results, whether the endpoint was reached; map each item that lost points to the requests that caused it, as findings.
7. **Artifacts against the skills' requirements.** Whether artifacts such as the Brief, Research, Tickets and the PR body meet what the skills require of them (quote the skill rule and the artifact text).
8. Write `output/findings-output-quality.json` as `findings.md` describes and check it with `jq .`.
