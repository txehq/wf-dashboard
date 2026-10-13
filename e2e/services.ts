import path from 'node:path';
import type { PlaywrightTestConfig } from '@playwright/test';
import {
  analysesServerPort,
  analysesWebPort,
  compareServerPort,
  compareWebPort,
  environmentServerPort,
  liveItemsServerPort,
  liveItemsWebPort,
  runsServerPort,
  runsWebPort,
  serverPort,
  webPort,
} from '../ports.js';

type WebServer = Exclude<NonNullable<PlaywrightTestConfig['webServer']>, unknown[]>;

const root = path.resolve(import.meta.dirname, '..');
// Compare 的 e2e 数据目录，由种子脚本清空后写入
const compareDataDir = '.work/e2e/compare-data';
// Runs 的 e2e 数据目录：保留在多次运行之间，其中有导入的 W4 端到端 run 与测试中构建的 variant
const runsDataDir = '.work/e2e/runs-data';
// 环境检查的 e2e 数据目录：每次删除重建，Settings 从默认值开始
const environmentDataDir = '.work/e2e/environment-data';
// Sessions 的服务端每次使用删除重建的数据库
const dbDir = path.join(root, '.work/e2e-db');
// Sessions 的来源目录：每次由种子脚本删除重建，放入真实 run 的 session
const projectsDir = path.join(root, '.work/e2e/projects');
// chromium 项目服务端的数据目录（variants.spec 在这里构建 variant）：保留在多次运行之间，wf runtime 只编译一次。
// 仓库根目录的 data/ 是用户实例的数据目录，e2e 不写进去
const chromiumDataDir = path.join(root, '.work/e2e/chromium-data');
// 分析页面的数据目录与来源目录：每次由 prepare-analyses-e2e 删除重建（两个真实 run 的 session 与 9f2bed6 的基线）
const analysesDataDir = '.work/e2e/analyses-data';
const analysesProjectsDir = path.join(root, '.work/e2e/analyses/projects');
// 交互项 e2e 的数据目录与来源目录：每次删除重建
export const liveItemsDir = path.join(root, '.work/e2e/live-items');
export const liveItemsProjectsDir = path.join(liveItemsDir, 'projects');
// Codex 草稿（Contracts 第 17 节）：skill 的来源是 prepare-codex-skills-e2e 建的本地 git 仓库，Codex 换成测试中的
// 替身命令（只验证页面与 API）
const codexSkillsDir = path.join(root, '.work/e2e/codex-skills');
const codexEnv = {
  WFD_CODEX_BIN: path.join(root, 'server/test/fixtures/codex/codex-stand-in.mjs'),
  WFD_CODEX_SKILL_SOURCES: JSON.stringify(
    ['find-skills', 'skill-creator', 'writing-for-agents'].map((name) => ({
      name,
      source: path.join(codexSkillsDir, name),
    })),
  ),
};

// 各 project 用到的服务。chromium 的服务端与页面继承本进程的 WFD_PORT、WFD_WEB_PORT；
// 其余几对服务读取各自的专用数据目录，端口见 ports.ts
export const services = {
  sessionsServer: {
    command: `rm -rf ${dbDir} && pnpm --filter @wf-dashboard/server prepare:sessions-e2e && pnpm --filter @wf-dashboard/server prepare:codex-skills-e2e && pnpm --filter @wf-dashboard/server dev`,
    url: `http://127.0.0.1:${String(serverPort)}/api/health`,
    env: {
      WFD_DATA_DIR: chromiumDataDir,
      WFD_DB_PATH: path.join(dbDir, 'db.sqlite'),
      WFD_CLAUDE_PROJECTS: projectsDir,
      ...codexEnv,
    },
    reuseExistingServer: false,
  },
  web: {
    command: 'pnpm --filter @wf-dashboard/web dev',
    url: `http://127.0.0.1:${String(webPort)}`,
    // 端口被其他 worktree 的页面占用时报错，不测试别人的页面
    reuseExistingServer: false,
  },
  compareServer: {
    command:
      'pnpm --filter @wf-dashboard/server seed:compare-e2e && pnpm --filter @wf-dashboard/server exec tsx src/main.ts',
    url: `http://127.0.0.1:${String(compareServerPort)}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { WFD_DATA_DIR: compareDataDir, WFD_PORT: String(compareServerPort) },
  },
  compareWeb: {
    command: 'pnpm --filter @wf-dashboard/web dev',
    url: `http://127.0.0.1:${String(compareWebPort)}`,
    reuseExistingServer: false,
    env: { WFD_PORT: String(compareServerPort), WFD_WEB_PORT: String(compareWebPort) },
  },
  runsServer: {
    command:
      'pnpm --filter @wf-dashboard/server prepare:runs-e2e && pnpm --filter @wf-dashboard/server exec tsx src/main.ts',
    url: `http://127.0.0.1:${String(runsServerPort)}/api/health`,
    reuseExistingServer: false,
    timeout: 600_000,
    env: { WFD_DATA_DIR: runsDataDir, WFD_PORT: String(runsServerPort) },
  },
  runsWeb: {
    command: 'pnpm --filter @wf-dashboard/web dev',
    url: `http://127.0.0.1:${String(runsWebPort)}`,
    reuseExistingServer: false,
    env: { WFD_PORT: String(runsServerPort), WFD_WEB_PORT: String(runsWebPort) },
  },
  environmentServer: {
    // 与 pnpm start 相同：构建后只开服务端一个端口
    command: `rm -rf ${environmentDataDir} && pnpm build && pnpm --filter @wf-dashboard/server start`,
    url: `http://127.0.0.1:${String(environmentServerPort)}/api/health`,
    reuseExistingServer: false,
    timeout: 300_000,
    env: { WFD_DATA_DIR: environmentDataDir, WFD_PORT: String(environmentServerPort) },
  },
  analysesServer: {
    command:
      'pnpm --filter @wf-dashboard/server prepare:analyses-e2e && pnpm --filter @wf-dashboard/server exec tsx src/main.ts',
    url: `http://127.0.0.1:${String(analysesServerPort)}/api/health`,
    reuseExistingServer: false,
    timeout: 300_000,
    env: {
      WFD_DATA_DIR: analysesDataDir,
      WFD_CLAUDE_PROJECTS: analysesProjectsDir,
      WFD_PORT: String(analysesServerPort),
    },
  },
  analysesWeb: {
    command: 'pnpm --filter @wf-dashboard/web dev',
    url: `http://127.0.0.1:${String(analysesWebPort)}`,
    reuseExistingServer: false,
    env: { WFD_PORT: String(analysesServerPort), WFD_WEB_PORT: String(analysesWebPort) },
  },
  liveItemsServer: {
    // 数据目录与来源目录每次删除重建；来源目录下的 session 目录由 live-items.spec 放入
    command: `rm -rf ${liveItemsDir} && mkdir -p ${liveItemsProjectsDir} && pnpm --filter @wf-dashboard/server exec tsx src/main.ts`,
    url: `http://127.0.0.1:${String(liveItemsServerPort)}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      WFD_DATA_DIR: path.join(liveItemsDir, 'data'),
      WFD_CLAUDE_PROJECTS: liveItemsProjectsDir,
      WFD_PORT: String(liveItemsServerPort),
      // live-fullscreen.spec 用"本机配置"resume：Claude Code 换成回显按键与终端尺寸的替身，HOME 在这里的目录中
      WFD_CLAUDE_BIN: path.join(root, 'server/test/fixtures/live/claude-stand-in.mjs'),
      WFD_LOCAL_HOME: path.join(liveItemsDir, 'home'),
    },
  },
  liveItemsWeb: {
    command: 'pnpm --filter @wf-dashboard/web dev',
    url: `http://127.0.0.1:${String(liveItemsWebPort)}`,
    reuseExistingServer: false,
    env: { WFD_PORT: String(liveItemsServerPort), WFD_WEB_PORT: String(liveItemsWebPort) },
  },
} satisfies Record<string, WebServer>;

export type Service = keyof typeof services;

// 只启动这次选中的 project 用到的服务：e2e/run.ts 先用 playwright test --list 得到选中的 project，
// 经 WFD_E2E_PROJECTS 传进来；直接运行 playwright test 时没有这个变量，启动全部 project 的服务
export function webServersFor(projects: Record<string, Service[]>): WebServer[] {
  const raw = process.env.WFD_E2E_PROJECTS;
  const selected = raw === undefined ? Object.keys(projects) : raw.split(',');
  const needed = new Set<Service>();
  for (const name of selected) {
    const list = projects[name];
    if (list === undefined)
      throw new Error(`WFD_E2E_PROJECTS 中的 project 不在这份配置中：${name}`);
    for (const service of list) needed.add(service);
  }
  return [...needed].map((service) => services[service]);
}
