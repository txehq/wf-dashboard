---
name: user-interaction
description: Session-analysis stage for interaction with the user — whether each question was necessary and easy to answer, questions that should have been asked, and the user's corrections, interruptions and dissatisfaction.
---

# 和用户的交互

先照 `session-analysis` skill 读过 `../session-analysis/references/` 的五份参考；证据、格式与归属以它们为准。输出：`output/findings-user-interaction.json`。

用户的话只取 `userMessagesBefore` 中 `kind` 为 `user` 的消息与 `conversation.json`。评估 run 中回答问题的是模拟用户，`run.json` 的对话记录了回答来自模拟用户还是人。违反用户此前明确要求的做法归 request-conflicts。

## 步骤

1. **列出交互。** 按时间列出每条用户消息、agent 的每次提问（回复文字中的问题、`AskUserQuestion` 的问题与选项）与回答，以及用户回复的用时（提问所在请求的 `timestamp` 到回答的时间）。
2. **每次提问。** 判断：
   - 是否必要：答案能否从仓库、工单、之前的对话或 skill 中直接得到；是否把已经问过、答过的问题再问一遍；
   - 是否简洁、可以直接点选：一次问了几个问题；选项是否完整、互斥；有没有推荐项；用语是否是用户看得懂的说法；
   - 回答是否改变了范围。

   完成条件：每次提问都有这三项判断。

3. **该问而没问。** 需求有歧义、或要做不可撤回的操作时 agent 没有问就做了，之后被用户纠正或返工。
4. **纠正、打断与不满。** 只按用户明确的话判断：纠正（"不对""不是这个"）、打断、重复同一要求、催促、不满（"算了""这坏了"）；以及明确的满意（"好""可以""谢谢"）。每处写出之前 agent 做了什么导致它。
5. 每条发现在 detail 中引用 skill 中关于提问与交互的规定（路径与原文），说明 skill 是否要求了这样的交互。
6. 按 `findings.md` 写出 `output/findings-user-interaction.json` 并用 `jq .` 检查。
