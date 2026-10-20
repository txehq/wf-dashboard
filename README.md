# Magi Dashboard

Magi Dashboard 是在本机评估 [txe-workflow](https://github.com/txehq/txe-workflow)（Magi workflow，`/lfg` 与 `/ic`）的网页。它可以：

- 打开本机已有的 Claude Code 与 Codex session，按 workflow 的阶段切块，看每个阶段的请求、token、花费与耗时；
- 修改 skill 得到 variant，用预先定义的 task 让 Claude Code 完整跑一遍 workflow，由 LLM 扮演的模拟用户回答 agent 的提问，跑完后评分；
- 把几个 variant 的分数与花费放在一起对比；
- 用 LLM 分析 session，给出 skill 的修改建议，另存为新的 variant。

完整的使用说明在 Obsidian vault 的 `Project Magi/Dashboard/User Guide.md`，设计与接口在同一目录的 `Brief.md`、`System Design.md`、`Contracts.md`。

## 安装

只支持 macOS（Apple Silicon）。安装分三步：先装好 txe-workflow，再准备 dashboard 用到的账号与工具，最后安装并启动 dashboard。

### 1. 安装 txe-workflow

按 txe-workflow 的 README 安装：<https://github.com/txehq/txe-workflow#install>

1. 按 [getting started](https://github.com/txehq/txe-workflow/blob/main/docs/operations/getting-started.md) 准备好账号、Obsidian vault 与发布用的凭据。
2. 把 README 中 Install 一节的那段 prompt 整段交给 Claude Code。它会运行 `/install`：检查平台与工具，下载并校验稳定版，把 `wf` 装进本机所有的 coding agent，再配置 Linear 与 artifact 发布。
3. 装完后运行 `wf doctor`，确认没有未通过的项。

dashboard 还要读取 txe-workflow 的源码，从它的某个 commit 导出基线 variant：

```sh
git clone https://github.com/txehq/txe-workflow.git ~/Project/txe/txe-workflow
```

放在别的位置时，用环境变量 `WFD_TXE_WORKFLOW` 指向它。

### 2. 准备 dashboard 用到的账号与工具

| 项                                                        | 用途                                                                                  | 安装或配置                                                                                                                                                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node 22.12 及以上、pnpm 12.10.1                           | 构建与运行 dashboard                                                                  | `npm install --global pnpm@12.10.1`                                                                                                                                                                                                 |
| `claude`（Claude Code CLI）                               | 被评估的 agent                                                                        | `npm install --global @anthropic-ai/claude-code`；`~/.claude/settings.json` 的 `env` 中要有 gateway 的 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` 与 sonnet / opus / haiku 的模型名                                               |
| `gh`，登录的账号是 txehq 的成员                           | 每个 run 在 txehq 建一个 `wfe-<runId>` 仓库，/ic 的 PR 也开在那里                     | `gh auth login --hostname github.com --git-protocol https --web`                                                                                                                                                                    |
| Linear MCP 的 OAuth 登录                                  | /ic 的工单副本建在 Linear TXE team 的 "Workflow Eval" project；从 Linear 导入 ic task | 运行 `npx -y mcp-remote https://mcp.linear.app/mcp`，在浏览器中授权，看到 Proxy established 后按 Ctrl-C                                                                                                                             |
| Codex CLI，`~/.codex/auth.json` 与 `~/.codex/config.toml` | skill 中的评审（/review-pr 等）调用 `codex exec`                                      | `codex login`                                                                                                                                                                                                                       |
| Obsidian vault，其中有 `Project Magi Eval/`               | /lfg 的产物写到 `Project Magi Eval/Features/<runId>/`                                 | vault 的位置由环境变量 `MAGI_VAULT` 决定，与 txe-workflow 的 `wf obsidian` 相同（`/install` 把 `export MAGI_VAULT=…` 写进 shell 的配置文件）；没有设时为 `~/Projects/Obsidian/TXE`。然后 `mkdir -p "$MAGI_VAULT/Project Magi Eval"` |
| `wf`、`uv`、`ctx`                                         | variant 的构建与安装；skill 在运行中调用的工具                                        | `wf` 与 `ctx` 由第 1 步装好；uv：`curl -LsSf https://astral.sh/uv/install.sh \| sh`                                                                                                                                                 |
| Rust（`cargo`）                                           | 构建 variant 时从基线 commit 的源码编译 `wf`                                          | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh`，然后在 txe-workflow 目录中运行一次 `cargo --version`，rustup 按它的 `rust-toolchain.toml` 装好钉住的版本                                                         |

### 3. 安装并启动 dashboard

本仓库是 txehq 组织的私有仓库，clone 要用 txehq 成员的 GitHub 账号（第 2 步 `gh auth login` 登录的账号；`gh auth setup-git` 让 git 使用它的凭据）。

```sh
git clone https://github.com/txehq/wf-dashboard.git
cd wf-dashboard
pnpm install
pnpm start
```

浏览器打开 <http://127.0.0.1:7317>。

- `pnpm start` 先构建页面与服务端，再由同一个进程在 7317 端口提供页面与 API。端口用 `WFD_PORT` 修改，例如 `WFD_PORT=7400 pnpm start`。
- 在普通终端（或 Orca 终端）中运行 `pnpm start`。从 Claude Code 的 Bash 后台启动的服务会随那次 Bash 调用一起结束，正在进行的 run 会中断。
- 运行时数据都在 `data/` 下：`db.sqlite`、`variants/`（每个 variant 的源码、构建产物与它自己的 Claude Code / Codex / wf 配置目录）、`runs/`（每个 run 的 workspace 与事件记录）。数据库迁移在服务启动时自动执行。
- 按 Ctrl-C 停止服务：正在运行的 run 记为失败，排队中的 run 保留，下次启动后继续排队。

打开页面后先看左侧导航底部的环境状态。「环境：全部通过」才能发起评估；有未通过的项时点开它，每一项都有真实的输出与修复命令。命令行上 `curl http://127.0.0.1:7317/api/environment` 给出同样的结果。

## 各模块的功能

```mermaid
flowchart LR
  WF[Workflows 与 variant] -->|构建好的 variant| RUNS[Runs]
  TASKS[Tasks] -->|task| RUNS
  RUNS -->|评分后的 run| CMP[Compare]
  RUNS -->|run 的 session| SES[Sessions]
  LIVE[Live] -->|交互的 session| SES
  SES -->|选中的 session| ANA[Analyses]
  ANA -->|修改建议另存| WF
  WF -->|variant| LIVE
```

### Sessions：离线分析

- 列出本机配置（`~/.claude/projects`、`~/.codex`）与每个 variant 配置目录下的 session，按配置、项目分三列选择，勾选后导入。导入的 session 文件变长时自动导入新增的部分。
- session 详情：请求数（含子代理）、token、花费、时长、各 tool 的调用次数，对话与每一次模型请求（思考、回复、tool 调用与结果）。
- 阶段划分：按主 agent 的 Skill 调用与用户输入的 slash 命令（`/lfg`、`/ic` 与阶段名）把 session 线性切块，不调用模型。阶段图的每个阶段框给出调用次数（fix-pr 为修复轮数）、请求、token、花费、耗时，点开列出这个阶段的请求。
- 清除、删除（连同磁盘上的文件）、Codex session 的归档与恢复；在 Live 中 resume。

### Workflows：workflow 与 variant

- 内置三个 workflow：`lfg`（interview、research、plan、ticketing）、`ic`（claim、readiness、implement、acceptance、open-pr、fix-pr、ready-for-review）与 `session-analysis`（分析 session 的九个方面加 synthesize）。也可以新建自己的 workflow，表单或 YAML 编辑阶段的定义，流程图随之更新。
- variant 是一个 workflow 的一组 skill。lfg、ic 的基线从 txe-workflow 的某个 commit 导入；之后派生新 variant，在页面的编辑器中修改 `skills/` 下的文件（Markdown 预览、并排、与基线的 diff、全屏）。
- 构建：lfg、ic 的 variant 用 `wf release build-local` 与 `wf install` 装进 variant 自己的配置目录，彼此隔离，不碰你的 `~/.claude`。其他 workflow 的 variant 由 dashboard 直接复制 skill。
- 生成 workflow 或 variant：写一句需求，在 Live 中由 Codex 或 Claude Code 写 skill，写好后保存。

### Tasks：task 库

- `/lfg` task 的输入是一个想法（例如「做一个计算器」），附模拟用户的 persona 与隐藏需求，以及按 brief、research、plan、tickets 四种产物分组的 rubric。
- `/ic` task 是一张工单加起始仓库，评分用隐藏测试或验收标准。可以手写工单，也可以粘贴 Linear 工单地址导入：正文原样保存，验收标准由 judge 模型从正文中确定，起始仓库与 commit 默认取工单关联的已合并 PR 的 base commit，必需的 CI check 从仓库的 workflow 中算出。

### Runs：发起与观察评估

- 勾选已构建的 variant 与 task，填重复次数、model 与 effort，发起一个 batch。run 进入全局队列（默认同时 3 个），依次经过 queued → preparing（建 GitHub 仓库，/ic 还在 Linear 建工单副本）→ running → grading → succeeded。
- 运行详情：状态、三项花费（agent、模拟用户、评分）、外部链接（仓库、工单、PR、vault 目录），阶段进度、与模拟用户的对话、请求流与产物。
- 运行中可以接管，由你回答 agent 的提问（run 标为有人工干预）；可以交还模拟用户、结束或取消。
- 评分：/lfg 按四种产物逐条 rubric 打分；/ic 给出隐藏测试的通过数或验收标准逐条的得分，以及是否跑到终点。
- 环境出错的 run 可以标为无效；失败、取消或无效的 run 可以重跑。

### Compare：对比 variant

- 选一个 workflow，再选要比较的 variant 与 task，按 variant 或按 variant 与模型分组。
- 分数表（平均分与离散程度，每个点是一次 run，点开看每条 rubric 的平均得分）、产物并排、各阶段的成本对比（花费、token、耗时、tool 调用数）、两个 variant 的 skill diff。
- 默认排除有人工干预的 run、参考了其他 run 的 run 与读取了来源工单的 run，各有开关放回；标为无效的 run 总是排除。

### Live：在页面中运行

- 在页面里的真实终端中运行一个 workflow（Claude Code 或 Codex），选 variant、环境、model 与 effort，由你或模拟用户驾驶；也可以 resume 任何一个 session。
- 「阶段与请求」抽屉显示这个 session 的阶段条、各阶段花费与耗时、请求明细。
- 页面全部关掉 2 分钟后，还在运行的交互进程自动结束；评估的 run 不受影响。

### Analyses：分析 session，优化 skill

- 选同一个配置下的若干 session，用 `session-analysis` 的某个 variant 分析：流程遵守、计划遵守、失败、重复的工作、token 与时间的浪费、和用户的交互、产物质量、与请求的冲突，最后综合出报告。每条发现都有 session 中的原文作证据。
- 修改建议逐处接受或拒绝后另存为新 variant；或点「优化」，在 Live 中交给 Codex 或 Claude Code 按报告修改 skill。

### Magi Agent

导航顶部「Magi Dashboard」右边的小机器人。它是 dashboard 自己的 agent，在 wf-dashboard 的独立 worktree 中工作：回答用法、讨论问题、按你的要求修改 dashboard，检查通过后合并进 main 并重启服务。

## 开发

```sh
pnpm dev
```

- 服务端：http://127.0.0.1:7317（只监听 127.0.0.1），健康检查 `GET /api/health`，实时事件 `GET /api/events`（SSE）。
- 页面：http://127.0.0.1:5173，开发时 `/api` 由 Vite 代理到服务端。

### 多个 worktree 并行运行

端口默认为服务端 7317、页面 5173，由环境变量 `WFD_PORT`、`WFD_WEB_PORT` 覆盖；`pnpm dev`、`pnpm e2e` 与 Vite 的 `/api` 代理都读取这两个变量。Playwright 在端口上已有服务时直接复用它，所以同时在几个 worktree 中运行时，每个 worktree 用一组不同的端口：

```sh
export WFD_PORT=7327 WFD_WEB_PORT=5183
pnpm dev
pnpm e2e
```

每个 worktree 的 `data/` 是各自独立的。

### 命令

| 命令                     | 作用                                                                    |
| ------------------------ | ----------------------------------------------------------------------- |
| `pnpm start`             | 构建后由服务端一个端口提供页面与 API                                    |
| `pnpm dev`               | 同时启动服务端（tsx watch）与页面（Vite）                               |
| `pnpm build`             | 编译服务端到 `server/dist/`，构建页面到 `web/dist/`                     |
| `pnpm check`             | 完整的基础档，全机同一时间只运行一份（见「测试」）                      |
| `pnpm test`              | 基础档的 Vitest（见「测试」）                                           |
| `pnpm test:real [文件…]` | 真实档的 Vitest                                                         |
| `pnpm test:slow [文件…]` | 慢档的 Vitest                                                           |
| `pnpm test:external`     | 在 Linear 建工单的外部系统测试                                          |
| `pnpm e2e [文件…]`       | 基础档的 Playwright，截图写到 `.work/screenshots/`                      |
| `pnpm e2e:real [文件…]`  | 真实档的 Playwright                                                     |
| `pnpm e2e:guide`         | 使用手册的截图（种子数据，不发起 run），写到 `.work/guide/screenshots/` |
| `pnpm typecheck`         | 全部 TypeScript 项目的类型检查                                          |
| `pnpm lint`              | ESLint 与 Prettier 检查                                                 |
| `pnpm format`            | Prettier 格式化                                                         |

修改 `server/src/db/schema.ts` 后，在 `server/` 下执行 `pnpm db:generate --name <迁移名>` 生成新的迁移文件。

### 测试

测试都使用真实服务，不使用 mock，分为三档：基础档每次改动后全部运行；慢档与真实档只运行覆盖改动的文件。任何测试都不在 GitHub 上创建仓库、PR 或 ruleset（`gh` 的写操作在测试中一律报错），需要仓库的逻辑在 `.work/` 下由测试建的本地 bare 仓库上测。

#### 基础档：每次改动后全部运行

第一次运行测试之前安装 Playwright 的浏览器（web 的 Vitest 与 e2e 都在其中运行）：

```sh
pnpm exec playwright install chromium
```

```sh
pnpm check
```

`pnpm check`（`check.ts`）依次运行 `pnpm typecheck`、`pnpm lint`、`pnpm test` 与 `pnpm e2e`，开始时打印基线（系统的 1 分钟 load average 与空闲内存），每一步结束时打印耗时、测试自身的 load 与系统 1 分钟 load average 的最高值、空闲内存（`vm.page_free_count`，即 `vm_stat` 的 Pages free）的最低值，最后汇总。测试自身的 load 每 5 秒用 `ps -AM` 数这一步的进程树中正在运行或等待 CPU 的线程，按 1 分钟 load average 的算法累积；系统 load 还含 macOS 与其他程序的后台活动。每 5 秒的取值连同当时的步骤与树之外最忙的 3 个进程写在 `.work/check-load.log`；两步之间先等系统 load 回落到基线 + 1 以内（最多 2 分钟）。全机同一时间只运行一份：开始前获取 `WFD_TEST_LOCK` 指向的锁（默认主仓库的 `.work/locks/basic-tier.lock`，各 worktree 共用这一个），另一份正在运行时打印「等待另一份基础档结束」并等待。

测试不能让机器过载：每一步测试自身的 load 不超过 4。为此 `pnpm check`、`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm test:slow`、`pnpm test:real`、`pnpm test:external`、`pnpm e2e`、`pnpm e2e:real` 与 `pnpm e2e:guide` 都经 `taskpolicy -c utility` 运行（QoS 限制为 utility，所有子进程继承，排在用户自己的程序之后）；同时运行的 Vitest 文件与 Playwright worker 的数量按实测写在 `server/vitest.config.ts`、`web/vitest.config.ts` 与 `playwright.config.ts` 中。

- `pnpm test`：Vitest 的 `local` 项目（`server/vitest.config.ts`）与 web 的测试。真实 SQLite、真实 jsonl 样本、录下的真实 gateway 与 GitHub 响应、本地 fixture 仓库上的真实 vitest 与计分，不访问网络。
- `pnpm e2e`：`playwright.config.ts`，种子数据与导入的真实 run。`e2e/run.ts` 先 `vite build` 一次页面（`.work/e2e/web-dist/`），再把选中的 project 按用到的服务分组，一组一组地运行：同一时间只有一组的服务端与页面（`vite preview`，`/api` 与 WebSocket 代理到这一组的服务端）在运行，这一组结束后停掉再开下一组。可以只给文件，例如 `pnpm e2e e2e/home.spec.ts`，这时只运行这个文件所在的组。每组的报告在 `.work/playwright/report/<组>/`。

基础档与慢档不调用真实模型、claude 与 Codex，不写 Linear：运行时 PATH 最前面是 `server/test/setup/basic-bin/` 中会报错的 `claude` 与 `codex`，gateway 认证换成基础档自己的 settings.json，其中地址是不存在的域名（`server/test/setup/basic-tier.ts`，不读本机的 `~/.claude/settings.json`），被拦下的调用记在 `.work/basic-tier/blocked.log`。基础档还不依赖网络：`gh` 也换成会报错的 `basic-bin/offline/gh`，读取真实 GitHub 的测试在真实档；`basic-bin/offline/npx` 拦下 Linear MCP 的 `npx -y mcp-remote`（其余 npx 调用照常执行）。页面加载时的环境检查也被拦下，状态显示为未通过，Linear 一项的 detail 是屏蔽的原文。

#### 慢档：只运行覆盖改动的文件

```sh
pnpm test:slow server/test/ic-tasks.test.ts
```

- `pnpm test:slow [文件…]`：Vitest 的 `slow` 项目，不调用真实模型，但单个文件要一分钟以上的测试（清单是 `server/vitest.config.ts` 中的 `slowTests`）：在起始仓库上 `npm ci` 并运行隐藏测试、评分 sandbox 的时限与隔离、ic 评分。

#### 真实档：只运行覆盖改动的文件

```sh
pnpm test:real server/test/llm.test.ts
pnpm e2e:real e2e/tasks-import.spec.ts
pnpm test:external
```

- `pnpm test:real [文件…]`：Vitest 的 `gateway` 项目，逐个文件顺序执行：真实调用 gateway 模型、claude 或 Codex 的测试（`server/vitest.config.ts` 中的 `gatewayTests`），以及读取真实 GitHub 的测试（`githubReadTests`：`repo-bundle`、`github-pr`、`friction`）。
- `pnpm e2e:real [文件…]`：`playwright.real.config.ts`，服务端真实调用 judge、claude、Codex 或 Linear MCP 的 spec 与用例，与 `pnpm e2e` 相同地按组依次运行选中的 spec。
- `pnpm test:external`：`server/test/*.external.test.ts`，配置在 `server/vitest.external.config.ts`，在 Linear TXE team 的 "Workflow Eval" project 中建带 `eval` label 的工单，工单全部保留。需要 Linear 已登录（`~/.mcp-auth` 中有 mcp-remote 的 token）。只在修改 `server/src/external/` 后运行。

慢档与真实档花时间，真实档还花钱：只运行覆盖这次改动的那几个文件，不运行整档。`pnpm test:slow`、`pnpm test:real` 与 `pnpm e2e:real` 不给文件时运行整档，开头打印"运行整个慢档"或"运行整个真实档"。

### 目录结构

| 路径                        | 内容                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `start.ts`、`check.ts`      | `pnpm start` 的守护进程；`pnpm check` 的基础档                                      |
| `ports.ts`                  | `WFD_PORT`、`WFD_WEB_PORT`，Playwright 与 Vite 共用                                 |
| `tasks/`                    | 内置的 task（`task.yaml`、起始仓库 bundle、隐藏测试）                               |
| `agent/MAGI.md`             | Magi Agent 开头注入的说明                                                           |
| `e2e/`                      | Playwright 测试                                                                     |
| `server/src/api/`           | Fastify 应用、各页面的路由、SSE                                                     |
| `server/src/db/`            | Drizzle 的 schema 与 SQLite 连接；迁移在 `server/drizzle/`                          |
| `server/src/ingest/`        | 读取 Claude Code 与 Codex 的 session 文件，增量导入                                 |
| `server/src/stages/`        | 按 Skill 调用与 slash 命令划分阶段，阶段的统计                                      |
| `server/src/workflows/`     | workflow 的定义（内置的 `lfg.yaml`、`ic.yaml`、`session-analysis`）                 |
| `server/src/variants/`      | variant 的导入、派生、编辑、构建、隔离的配置目录、安装到本机                        |
| `server/src/tasks/`         | task 的读取与校验，从 Linear 导入，验收标准与 rubric 的起草，workflow 的 check 分析 |
| `server/src/runs/`          | run 的队列、准备、claude 进程、模拟用户、记录、花费                                 |
| `server/src/grading/`       | rubric judge、隐藏测试、验收标准的评分、对比的统计                                  |
| `server/src/external/`      | GitHub（`gh`）与 Linear MCP                                                         |
| `server/src/live/`          | Live 的终端、resume                                                                 |
| `server/src/drafts/`        | 生成 workflow 与 variant 的草稿                                                     |
| `server/src/insights/`      | session 的分析                                                                      |
| `server/src/magi-agent/`    | Magi Agent 的 worktree 与部署                                                       |
| `server/src/deletion/`      | 删除 session、variant 与 workflow                                                   |
| `server/src/llm/`           | gateway 模型的调用、价格表                                                          |
| `server/src/environment.ts` | 环境检查                                                                            |
| `web/src/app/`              | 路由与布局（左侧导航）                                                              |
| `web/src/pages/`            | 各页面                                                                              |
| `web/src/components/`       | 共用组件；`ui/` 为 shadcn/ui 组件                                                   |
| `data/`                     | 运行时数据（gitignore）                                                             |
| `.work/`                    | 中间文件、测试数据、截图（gitignore）                                               |
