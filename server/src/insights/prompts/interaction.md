<!--
改写自 superpowers 的 diagnosing-superpowers skill（prompts/request-conflicts.md），并加上提问是否必要、是否简洁可点、用户的纠正与不满：
https://github.com/obra/superpowers ，MIT License，Copyright (c) 2025 Jesse Vincent。
-->

## 方面：和用户的交互

用户消息在 `userMessagesBefore`（kind 为 `user`）与 `conversation.json` 中；`notice` 是系统事件，不是用户说的话。
评估 run 中回答问题的是模拟用户，`run.json` 中的对话记录了回答来自模拟用户还是人。

1. 指令冲突：列出用户每条消息中的指令（必须、不要、只、总是、范围），报告：
   - 两条无法同时满足的用户指令，以及 agent 怎么处理的；
   - 用户指令与 skill 规定冲突（引用两边的原文），以及 agent 怎么处理的；
   - 用户要求跳过或改变某一步时，之后发生了什么。
2. 提问：对 agent 的每次提问（回复文字中的问题、`AskUserQuestion`），判断：
   - 是否必要：答案能否从仓库、工单、之前的对话或 skill 中直接得到；问过的问题是否又问了一遍；
   - 是否简洁、可以直接点选：一次问了多少个问题，选项是否完整、互斥，是否有推荐项，问题是否用了用户看不懂的说法；
   - 用户（或模拟用户）的回答是否改变了范围。
3. 纠正与不满：用户纠正 agent、重复同一要求、表达不满或催促的地方，以及之前 agent 做了什么导致它。
4. 对每一条发现，在 detail 中引用 skill 中关于提问或交互的规定（路径与原文），说明 skill 是否要求了这样的交互。
