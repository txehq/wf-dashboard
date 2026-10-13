# 证据规则

dashboard 对每条证据做两项检查，任何一条不满足，这个阶段整体失败：

- `sessionId` 是 `input/case.json` 中的一个 session；`seq` 是该 session 中**主 agent** 某一行的 `seq`。证据在子代理的请求中时，写那条子代理请求的 `parentSeq`。
- `quote` 是那一行（或 `parentSeq` 指向它的子代理行）某一个字符串字段的值中**原样复制**的连续片段：不超过 200 个字符，不加省略号，不改空白、标点与大小写，不跨字段拼接，不翻译。JSON 中转义的字符（`\n`、`\"`）在 quote 中写成它代表的字符。

最可靠的取法：用 `jq -r` 取出那个字段的原文，从输出中复制一段不含换行的片段。

其余规则：

- 每条发现至少一条证据。没有证据的结论不写成发现。
- 数字（次数、token、花费、秒数）只来自记录或你运行的命令；在 detail 中写明算法（例如"seq 12–40 的 `costUsd` 之和"）。
- 用户的话只取 `userMessagesBefore` 中 `kind` 为 `user` 的消息与 `conversation.json`；hook 输出、系统事件与 tool 结果不是用户的话。子代理的记录中，"user" 是派出它的主 agent。
