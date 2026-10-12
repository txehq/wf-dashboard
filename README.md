# Magi Workflow Dashboard

在本机评估 txe-workflow（Magi workflow）的 web 页面：离线分析 Claude Code session、发起评估运行、编辑 skill variant、管理 task、对比分数与成本。设计文档在 Obsidian vault 的 `Project Magi/Dashboard/`。

## 安装

需要 Node 22.12 及以上与 pnpm 12。

```sh
npm install --global pnpm@12.10.1
pnpm install
pnpm exec playwright install chromium
```

## 本地使用

```sh
pnpm install
pnpm start
```

`pnpm start` 构建页面与服务端，由同一个进程在 http://127.0.0.1:7317 提供页面与 API（端口由 `WFD_PORT` 覆盖），只需要打开这一个地址。运行时数据写在 `data/`。

页面左侧导航底部是运行环境的检查结果（`GET /api/environment`）：claude、gateway 上三个角色的模型、gh 与 txehq、Linear MCP、Codex、Obsidian vault、txe-workflow 仓库、`wf` / `uv` / `ctx`。未通过的项点开可以看到真实输出与修复命令。

第一次使用请读 Obsidian vault 中的使用手册 `Project Magi/Dashboard/User Guide.md`：安装与启动、环境检查各项的修复、一次完整评估的操作步骤、离线分析、花费与时长的参考、已知限制。

## 运行

```sh
pnpm dev
```

- 服务端：http://127.0.0.1:7317（只监听 127.0.0.1），健康检查 `GET /api/health`，实时事件 `GET /api/events`（SSE）。
- 页面：http://127.0.0.1:5173，开发时 `/api` 由 Vite 代理到服务端。
- 运行时数据写在 `data/`（`db.sqlite`、`variants/`、`runs/`），服务端启动时自动执行数据库迁移。

### 多个 worktree 并行运行

端口默认为服务端 7317、页面 5173，由环境变量 `WFD_PORT`、`WFD_WEB_PORT` 覆盖；`pnpm dev`、`pnpm e2e` 与 Vite 的 `/api` 代理都读取这两个变量。Playwright 在端口上已有服务时直接复用它，所以同时在几个 worktree 中运行时，每个 worktree 用一组不同的端口：

```sh
export WFD_PORT=7327 WFD_WEB_PORT=5183
pnpm dev
pnpm e2e
```

每个 worktree 的 `data/` 是各自独立的。

## 命令

| 命令                     | 作用                                                                    |
| ------------------------ | ----------------------------------------------------------------------- |
| `pnpm start`             | 构建后由服务端一个端口提供页面与 API                                    |
| `pnpm dev`               | 同时启动服务端（tsx watch）与页面（Vite）                               |
| `pnpm build`             | 编译服务端到 `server/dist/`，构建页面到 `web/dist/`                     |
| `pnpm test`              | 基础档的 Vitest（见「测试」）                                           |
| `pnpm test:real [文件…]` | 真实档的 Vitest                                                         |
| `pnpm test:slow [文件…]` | 慢档的 Vitest                                                           |
| `pnpm test:external`     | 在 Linear 建工单的外部系统测试                                          |
| `pnpm e2e [文件…]`       | 基础档的 Playwright，截图写到 `.work/screenshots/`                      |
| `pnpm e2e:real [文件…]`  | 真实档的 Playwright                                                     |
| `pnpm e2e:guide`         | 使用手册的截图（真实发起一个 lfg run），写到 `.work/guide/screenshots/` |
| `pnpm typecheck`         | 全部 TypeScript 项目的类型检查                                          |
| `pnpm lint`              | ESLint 与 Prettier 检查                                                 |
| `pnpm format`            | Prettier 格式化                                                         |

修改 `server/src/db/schema.ts` 后，在 `server/` 下执行 `pnpm db:generate --name <迁移名>` 生成新的迁移文件。

## 测试

测试都使用真实服务，不使用 mock，分为三档：基础档每次改动后全部运行；慢档与真实档只运行覆盖改动的文件。任何测试都不在 GitHub 上创建仓库、PR 或 ruleset（`gh` 的写操作在测试中一律报错），需要仓库的逻辑在 `.work/` 下由测试建的本地 bare 仓库上测。

### 基础档：每次改动后全部运行

```sh
pnpm typecheck && pnpm lint && pnpm test && pnpm e2e
```

- `pnpm test`：Vitest 的 `local` 项目（`server/vitest.config.ts`）与 web 的测试。真实 SQLite、真实 jsonl 样本、录下的真实 gateway 与 GitHub 响应、本地 fixture 仓库上的真实 vitest 与计分。
- `pnpm e2e`：`playwright.config.ts`，种子数据与导入的真实 run，只启动这些 spec 用到的服务。可以只给文件，例如 `pnpm e2e e2e/home.spec.ts`，这时只启动这个文件所在 project 的服务。

基础档与慢档不调用真实模型、claude 与 Codex，不写 Linear：运行时 PATH 最前面是 `server/test/setup/basic-bin/` 中会报错的 `claude` 与 `codex`，gateway 的地址换成不存在的域名（`server/test/setup/basic-tier.ts`），被拦下的调用记在 `.work/basic-tier/blocked.log`。页面加载时的环境检查也被拦下，状态显示为未通过。

### 慢档：只运行覆盖改动的文件

```sh
pnpm test:slow server/test/ic-tasks.test.ts
```

- `pnpm test:slow [文件…]`：Vitest 的 `slow` 项目，不调用真实模型，但单个文件要一分钟以上的测试（清单是 `server/vitest.config.ts` 中的 `slowTests`）：在起始仓库上 `npm ci` 并运行隐藏测试、评分 sandbox 的时限与隔离、ic 评分。

### 真实档：只运行覆盖改动的文件

```sh
pnpm test:real server/test/llm.test.ts
pnpm e2e:real e2e/tasks-import.spec.ts
pnpm test:external
```

- `pnpm test:real [文件…]`：Vitest 的 `gateway` 项目，真实调用 gateway 模型、claude 或 Codex 的测试（清单是 `server/vitest.config.ts` 中的 `gatewayTests`），逐个文件顺序执行。
- `pnpm e2e:real [文件…]`：`playwright.real.config.ts`，服务端真实调用 judge、claude、Codex 或 Linear MCP 的 spec 与用例，只启动选中的 spec 用到的服务。
- `pnpm test:external`：`server/test/*.external.test.ts`，配置在 `server/vitest.external.config.ts`，在 Linear TXE team 的 "Workflow Eval" project 中建带 `eval` label 的工单，工单全部保留。需要 Linear 已登录（`~/.mcp-auth` 中有 mcp-remote 的 token）。只在修改 `server/src/external/` 后运行。

慢档与真实档花时间，真实档还花钱：只运行覆盖这次改动的那几个文件，不运行整档。`pnpm test:slow`、`pnpm test:real` 与 `pnpm e2e:real` 不给文件时运行整档，开头打印"运行整个慢档"或"运行整个真实档"。

## 目录结构

```
wf-dashboard/
  package.json              # pnpm workspace 根，汇总脚本
  pnpm-workspace.yaml
  tsconfig.base.json        # 共用的 strict 编译选项
  eslint.config.js
  playwright.config.ts
  ports.ts                  # WFD_PORT、WFD_WEB_PORT，Playwright 与 Vite 共用
  e2e/                      # Playwright 测试
  server/
    drizzle.config.ts
    drizzle/                # drizzle-kit 生成的迁移
    src/
      main.ts               # 入口：打开数据库、迁移、监听端口
      config.ts             # 路径、端口、并发数
      db/                   # schema.ts 与数据库连接
      api/                  # Fastify 应用、路由、SSE
    test/                   # Vitest 测试
  web/
    components.json         # shadcn/ui 配置
    vite.config.ts
    src/
      main.tsx
      app/                  # 路由与布局（左侧导航）
      pages/                # Sessions、Runs、Variants、Tasks、Compare
      components/           # 共用组件；ui/ 为 shadcn/ui 组件
      lib/                  # API 请求、工具函数
  data/                     # 运行时数据（gitignore）
  .work/                    # 中间文件、测试数据库、截图（gitignore）
```
