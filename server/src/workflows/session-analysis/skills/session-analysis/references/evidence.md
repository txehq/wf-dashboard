# Evidence rules

The dashboard checks two things for every evidence item; if any item fails, the whole stage fails:

- `sessionId` is a session in `input/case.json`; `seq` is the `seq` of a **main agent** line in that session. When the evidence is in a subagent request, write the `parentSeq` of that subagent request.
- `quote` is a contiguous fragment **copied verbatim** from the value of one string field of that line (or of a subagent line whose `parentSeq` points to it): at most 200 characters, no ellipsis, no changes to whitespace, punctuation or case, not joined across fields, not translated. Characters escaped in JSON (`\n`, `\"`) are written in the quote as the characters they stand for.

The most reliable way: take the field's original text with `jq -r` and copy a fragment without line breaks from the output.

Other rules:

- Every finding has at least one evidence item. A conclusion without evidence is not written as a finding.
- Numbers (counts, tokens, cost, seconds) come only from the records or from commands you ran; state the method in detail (for example "sum of `costUsd` over seq 12–40").
- The user's words come only from messages in `userMessagesBefore` whose `kind` is `user` and from `conversation.json`; hook output, system events and tool results are not the user's words. In a subagent's records, "user" is the main agent that dispatched it.
