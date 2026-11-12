---
name: user-interaction
description: Session-analysis stage for interaction with the user — whether each question was necessary and easy to answer, questions that should have been asked, and the user's corrections, interruptions and dissatisfaction.
---

# Interaction with the user

First read the five references in `../session-analysis/references/` as the `session-analysis` skill says; they govern evidence, format and ownership. Output: `output/findings-user-interaction.json`.

The user's words come only from messages in `userMessagesBefore` whose `kind` is `user` and from `conversation.json`. In eval runs the simulated user answers questions; the conversation in `run.json` records whether an answer came from the simulated user or a person. Acting against something the user explicitly asked for earlier belongs to request-conflicts.

## Steps

1. **List the interactions.** In time order, list each user message, each question the agent asked (questions in reply text, and `AskUserQuestion` questions and options) with its answer, and how long the user took to reply (from the `timestamp` of the request with the question to the time of the answer).
2. **Each question.** Judge:
   - whether it was necessary: could the answer come straight from the repository, the ticket, the earlier conversation or the skills; was a question already asked and answered asked again;
   - whether it was concise and easy to answer by clicking: how many questions were asked at once; whether the options were complete and mutually exclusive; whether one was recommended; whether the wording is something the user understands;
   - whether the answer changed the scope.

   Done when: every question has these three judgments.

3. **Should have asked and did not.** The requirement was ambiguous, or an irreversible action was about to happen, and the agent went ahead without asking, then got corrected by the user or had to redo work.
4. **Corrections, interruptions and dissatisfaction.** Judge only from what the user explicitly said: corrections ("that's wrong", "not this one"), interruptions, repeating the same request, nudges, dissatisfaction ("forget it", "this is broken"); and explicit satisfaction ("good", "fine", "thanks"). For each, say what the agent did before that led to it.
5. In each finding's detail, quote the skill rules about questions and interaction (path and text), and say whether the skills required such an interaction.
6. Write `output/findings-user-interaction.json` as `findings.md` describes and check it with `jq .`.
