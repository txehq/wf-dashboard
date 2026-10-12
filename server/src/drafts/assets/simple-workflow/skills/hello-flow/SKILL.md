---
name: hello-flow
description: 把用户的一句话写成一段短文。Use when the user types /hello-flow <话题>.
---

# /hello-flow

依次经过三个阶段，每个阶段开始时调用它的 skill：

1. `Skill(gather)`：问清楚要写什么。
2. `Skill(draft)`：写出短文。
3. `Skill(review)`：检查并修改，直到用户满意。

用户输入的话题原样交给 gather。
