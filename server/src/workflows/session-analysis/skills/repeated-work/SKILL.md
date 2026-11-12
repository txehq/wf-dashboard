---
name: repeated-work
description: Session-analysis stage for repeated work — reads, searches, edits, commands and subagents done more than once with nothing changing in between, re-reads after compaction, and conclusions derived twice.
---

# Repeated work

First read the five references in `../session-analysis/references/` as the `session-analysis` skill says; they govern evidence, format and ownership. Output: `output/findings-repeated-work.json`.

Keyword: **rework**. Retries after a failure belong to failures, polling and status checks to time-waste; this stage does not report them.

## Steps

1. **Extract the calls.** Write every tool call (main agent and subagents) as `(seq, agent, tool, key)`:

   | tool                                       | key                                                      |
   | ------------------------------------------ | -------------------------------------------------------- |
   | Reading, writing, editing files            | file path                                                |
   | shell                                      | the full command (trailing whitespace removed)           |
   | Subagents (Agent, Task)                    | `description` plus the first 80 characters of the prompt |
   | Search (Grep, Glob, WebSearch, MCP search) | query and scope                                          |

   Generate this table with jq into `output/work/calls.jsonl`; all grouping afterwards is computed from it.

2. **Groups and thresholds.** Group by `(tool, key)` and report the groups that reach the threshold:

   | Category        | Threshold                | Not counted                          |
   | --------------- | ------------------------ | ------------------------------------ |
   | Reads, searches | 3 times                  |                                      |
   | Edits           | 2 times                  |                                      |
   | shell           | 2 times                  | `git status`, `ls`, `pwd`, test runs |
   | Subagents       | same description 2 times |                                      |

   Done when: every group that reaches its threshold has a verdict (next step).

3. **Verdict.** For each group, look at what happened between occurrences:
   - a write to that file, or a user correction: normal, not a finding;
   - a context compaction (`notice`): a finding, attributed to the compaction;
   - a failure: belongs to failures, skip it;
   - nothing: a finding.

   Each finding gives the count and the first and last seq.

4. **Re-derivation.** Find replies that reach again a conclusion already reached earlier (the same file, the same design choice, the same command to run); quote both places.
5. **Repeated subagents.** Several subagents doing the same thing (prompts with the same goal), or a subagent redoing work the main agent already did.
6. Each finding gives the extra tokens and cost of the repetition (the sum over the requests of every occurrence except the first, with the method).
7. Write `output/findings-repeated-work.json` as `findings.md` describes and check it with `jq .`.
