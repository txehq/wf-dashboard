# Magi Workflow Dashboard

在本机评估 txe-workflow（Magi workflow）的 web 页面：离线分析 Claude Code session、发起评估运行、编辑 skill variant、管理 task、对比分数与成本。设计文档在 Obsidian vault 的 `Project Magi/Dashboard/`。

## 安装

需要 Node 22.12 及以上与 pnpm 12。

```sh
npm install --global pnpm@12.10.1
pnpm install
pnpm exec playwright install chromium
```

## 运行

```sh
pnpm dev
```

- 服务端：http://127.0.0.1:7317（只监听 127.0.0.1），健康检查 `GET /api/health`，实时事件 `GET /api/events`（SSE）。
- 页面：http://127.0.0.1:5173，开发时 `/api` 由 Vite 代理到服务端。
- 运行时数据写在 `data/`（`db.sqlite`、`variants/`、`runs/`），服务端启动时自动执行数据库迁移。

## 命令

| 命令             | 作用                                                                   |
| ---------------- | ---------------------------------------------------------------------- |
| `pnpm dev`       | 同时启动服务端（tsx watch）与页面（Vite）                              |
| `pnpm build`     | 编译服务端到 `server/dist/`，构建页面到 `web/dist/`                    |
| `pnpm test`      | Vitest，服务端测试在 `.work/test-db/` 下用真实 SQLite 文件跑迁移并读写 |
| `pnpm e2e`       | Playwright，自动启动两个开发服务器，截图写到 `.work/screenshots/`      |
| `pnpm typecheck` | 全部 TypeScript 项目的类型检查                                         |
| `pnpm lint`      | ESLint 与 Prettier 检查                                                |
| `pnpm format`    | Prettier 格式化                                                        |

修改 `server/src/db/schema.ts` 后，在 `server/` 下执行 `pnpm db:generate --name <迁移名>` 生成新的迁移文件。

## 目录结构

```
wf-dashboard/
  package.json              # pnpm workspace 根，汇总脚本
  pnpm-workspace.yaml
  tsconfig.base.json        # 共用的 strict 编译选项
  eslint.config.js
  playwright.config.ts
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
