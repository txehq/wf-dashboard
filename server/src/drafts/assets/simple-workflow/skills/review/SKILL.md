---
name: review
description: hello-flow 的最后一个阶段：对照要求检查 hello.md，按用户意见修改。
---

# review

对照读者、长度与语气检查 `hello.md`，列出不符合的地方并改好，然后把短文给用户看。

用户提出修改时改完再调用一次 `Skill(review)`（review 可以重复）。用户满意时结束，报告 `hello.md` 的位置。
