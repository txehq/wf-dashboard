# 接入 wf-dashboard

这个目录是一个草稿：你在这里写 skill，用户在 dashboard 中点"保存"，dashboard 校验并构建后，得到一个新 workflow，或已有 workflow 的一个新 variant。

## 目录

- `src/skills/`：这个 workflow 的全部 skill，每个目录一个 `SKILL.md` 与它引用的文件。新 workflow 的草稿从空白骨架开始：入口与 `workflow.yaml` 中每个小阶段各一个只有 frontmatter 与一行说明的 `SKILL.md`，由你写成完整的 skill。
- `workflow.yaml`：workflow 的定义。新 workflow 的草稿由你修改；新 variant 的草稿中它是只读的副本，入口与小阶段不能改。
- `examples/simple-workflow/`：一个完整的小例子，照它的形状写。

## workflow 是什么

一个入口命令加一串有顺序的小阶段：

```yaml
id: hello-flow # 入口命令 /hello-flow，也是入口 skill 的名字
name: 你好流程
stages: # 小阶段，名字即 skill 名
  - id: gather
  - id: draft
  - id: review
    repeatable: true # 再次进入只记次数，不算新一轮
    allowInside: [draft] # 在 review 中调用 draft 不算切换阶段
```

- 入口 skill 与 workflow id 同名：`src/skills/hello-flow/SKILL.md`。用户输入 `/hello-flow <问题>` 时它被调用。
- 每个小阶段是一个同名 skill：`src/skills/gather/SKILL.md`……
- 每个阶段开始时，agent 调用对应的 Skill（`Skill(gather)`）。dashboard 只按这些 Skill 调用划分阶段：一个阶段从它的调用开始，到下一个阶段的调用为止。所以每个 skill 都要写清它结束时调用哪一个阶段的 skill。
- 阶段按定义的顺序推进；调用排在前面的阶段，或再次调用当前阶段，都开始新的一轮。`repeatable` 的阶段再次调用自己时留在本轮（修复循环）；`allowInside` 列出的阶段在本阶段中调用时不切换（例如修复后重跑检查）。
- workflow id 与小阶段 id 只用小写字母、数字与连字符，以字母开头；小阶段 id 不能与 workflow id 相同。改了 `workflow.yaml` 中的小阶段，就同样增删或改名 `src/skills/` 中对应的目录。

## 保存时 dashboard 做的事

这个 workflow 不用 wf：skill 由 dashboard 自己管理，没有 registry 或 docs 之类的清单要维护。按顺序检查，任何一步失败都把原文显示给用户，草稿保留，你可以接着改：

1. 新 workflow：`workflow.yaml` 符合上面的结构，id 没有被其他 workflow 使用。
2. 入口 skill 与每个小阶段的 skill 都在 `src/skills/` 中。
3. `src/skills/` 中每个目录都有 `SKILL.md`，以 YAML frontmatter 开头，有 `name` 与 `description`，`name` 与目录名相同。
4. 构建：把 `src/skills/` 原样复制进这个 variant 自己的 Claude Code 配置目录的 `skills/`。之后用户在 Live 中运行 `/<入口> <问题>` 时，Claude Code 从那里加载这些 skill；用户也可以在 variant 页面把它们安装到本机的 `~/.claude/skills/` 与 `~/.agents/skills/`。

## 写 skill

下面的三个 skill 已装在本目录的 skill 目录中：Codex 为 `.agents/skills/`，Claude Code 为 `.claude/skills/`（初始消息中写明是哪一个）。

- 用 writing-for-agents 的原则写：短，只写 agent 不知道的东西。
- 用 skill-creator 建 skill 的结构。
- 需要现成的 skill 时用 find-skills 搜索；安装时用项目范围（不加 `-g`），装进本目录的 skill 目录。要把它变成 workflow 的一部分，复制进 `src/skills/`。
