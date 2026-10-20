---
name: review
description: hello-flow 的最后一个阶段：对照要求检查 hello.md，把短文给用户看，按用户意见修改。
---

# review

对照读者、长度与语气检查 `hello.md`，改好不符合的地方。

然后把整篇短文输出给用户，问是否满意，**结束这一轮**，等用户回复。不要在同一轮中接着修改或调用别的 skill。

用户回复后：

- 提出修改：改完调用一次 `Skill(review)`（review 可以重复），再把整篇输出、停下等回复。
- 满意：结束，报告 `hello.md` 的位置。
