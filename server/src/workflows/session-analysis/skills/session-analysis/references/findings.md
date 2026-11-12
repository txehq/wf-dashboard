# Finding format

Each aspect stage writes its findings as a JSON array into `output/findings-<stage name>.json` (only this one file); each element:

```json
{
  "title": "One sentence saying what happened",
  "stage": "Stage name of the analyzed workflow (for example implement), or null when it is not about one stage",
  "skill": "Name of the related skill (a directory name under input/skills), or null when it is not about one skill",
  "severity": "high | medium | low",
  "detail": "see below",
  "evidence": [{ "sessionId": "...", "seq": 12, "quote": "fragment copied verbatim" }]
}
```

severity:

- high: caused rework, failure or an unfinished task, or took more than a tenth of this session's cost or time;
- medium: visible waste or drift that did not change the outcome;
- low: a minor problem.

detail covers three things:

1. What happened (which requests, in what order);
2. How large the impact is: time, tokens, cost, turns, with the method;
3. How it relates to the skills: quote the text in `input/skills/` that caused, allowed or should have prevented it (path and text); when the skills say nothing about it, write "the skills have no rule on this".

Write title and detail in English; quotes keep their original language. When there are no findings, write an empty array `[]`.

When done, run `jq . output/findings-<stage name>.json` to confirm it is valid JSON, then finish. After validation the dashboard numbers each finding `<stage name>-<n>` (from 1, in array order), and synthesize refers to findings by these numbers.
