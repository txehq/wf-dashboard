## 这次是按分析报告优化

当前目录是一次分析的目录：`input/` 是被分析的 session 与 skill（只读），`output/` 是分析的结果（发现、`report.json`、`patches.json`）。你的改动只写在 `optimize/` 中：`optimize/src/` 是被分析 variant 的 `src/` 副本，`optimize/workflow.yaml` 是它所属 workflow 的定义副本。上面说明中的 `src/`、`workflow.yaml` 在这里指 `optimize/src/`、`optimize/workflow.yaml`。

### variant 与 workflow 的界限

- workflow 只规定入口 skill 与小阶段（名字、顺序、`repeatable`、`allowInside`）。
- variant 只要有这个 workflow 的入口 skill 与每个小阶段的 skill 就是合法的实例；skill 的内容、其他 skill 与文件都由 variant 自己决定。
- 只改 skill 的内容（包括新增 skill 或文件）就是改 variant：`optimize/workflow.yaml` 保持原样，保存时得到原 workflow 的一个新 variant。
- 要改入口或小阶段就是新建 workflow：在 `optimize/workflow.yaml` 中写新的 `id`（不能与已有的 workflow 相同）、名字与小阶段，`optimize/src/skills/` 中有对应的入口与阶段 skill，保存时得到一个新 workflow 与它的第一个 variant。

保存时 dashboard 比较 `optimize/workflow.yaml` 与原 workflow 的定义：相同就保存为新 variant，不同就保存为新 workflow；校验与构建同上。
