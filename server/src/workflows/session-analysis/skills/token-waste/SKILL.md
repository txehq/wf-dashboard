---
name: token-waste
description: Session-analysis stage for token waste — where tokens and cost went by stage, subagent and skill, then the avoidable part — oversized reads and outputs, unused large results, context snowball, unnecessary subagents, cache rebuilds after compaction, always-on skill descriptions.
---

# Token waste

First read the five references in `../session-analysis/references/` as the `session-analysis` skill says; they govern evidence, format and ownership. Output: `output/findings-token-waste.json`.

Keyword: **snowball** — the context keeps growing and every request pays for everything before it. The cost of failure chains belongs to failures and repeated reads to repeated-work; this stage reports consumption that is too large in a single step or not needed at all.

## Steps

1. **Accounts.** From each line's `tokens` and `costUsd` (both increments of that request), compute:
   - each session's total cost, total input (`input + cacheRead + cacheCreation`) and total output;
   - cost and share by stage (`stages.json`), by subagent and by `attributionSkill`;
   - thinking tokens: the sum of `tokens` over the blocks of each line's `thinking`, totaled by stage and as a share of total output;
   - the five most expensive requests.

   Put these numbers in the detail of the related findings; any part above a tenth of the total cost must appear in some finding. Done when: every stage in `stages.json` has a cost and a share.

2. **Oversized results.** Measure the size of each tool result (characters of `result` and `spilledOutput`, about 4 characters per token) and list the ten largest. A single result above about 25,000 tokens, or a whole large file read when only a small part was used (later replies and calls touch only a few of its lines), is one finding each.
3. **Unused context.** After a large result (above about 5,000 tokens), no reply or call ever refers to its content again.
4. **Snowball.** Total input per request as seq advances: find stretches of steady growth without compaction or subagents sharing the load, with start and end seq and the amount of growth.
5. **Subagents.** Subagents for work that one or two steps would finish, whose results go unused, or that read the same large content as the main agent.
6. **Compaction and cache.** Where and how often context compaction (`notice`) happens; spikes of `cacheCreation` after compaction (cache rebuilds); stretches with little `cacheRead` and much `cacheCreation` (cache misses).
7. **Standing cost of skills.** The `description` length of each skill in `input/skills/`; skills never called in the session still take description tokens in every request.
8. Write `output/findings-token-waste.json` as `findings.md` describes and check it with `jq .`.
