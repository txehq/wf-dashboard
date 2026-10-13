# 发现的格式

每个方面阶段把发现写成一个 JSON 数组，写入 `output/findings-<阶段名>.json`（只写这一个文件），每个元素：

```json
{
  "title": "一句话说明发生了什么",
  "stage": "被分析 workflow 的阶段名（例如 implement），不针对某个阶段时为 null",
  "skill": "相关的 skill 名（input/skills 下的目录名），不针对某个 skill 时为 null",
  "severity": "high | medium | low",
  "detail": "见下",
  "evidence": [{ "sessionId": "...", "seq": 12, "quote": "原样复制的片段" }]
}
```

severity：

- high：造成返工、失败、没有完成任务，或占这次 session 花费或时间的一成以上；
- medium：可见的浪费或偏离，但没有改变结果；
- low：小问题。

detail 写三件事：

1. 发生了什么（哪些请求，按什么顺序）；
2. 影响多大：时间、token、花费、轮数，写出算法；
3. 与 skill 的关系：引用 `input/skills/` 中导致、允许或本应防止它的原文（路径与原文）；skill 中没有相关规定时写明"skill 没有规定"。

标题与 detail 用中文；quote 保持原文语言。没有发现时写空数组 `[]`。

写完后运行 `jq . output/findings-<阶段名>.json` 确认是合法的 JSON，然后结束。dashboard 校验通过后给每条发现编号 `<阶段名>-<序号>`（从 1 开始，按数组顺序），synthesize 用这个编号引用它。
