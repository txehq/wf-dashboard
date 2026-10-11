import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import {
  compareServerPort,
  compareWebPort,
  environmentServerPort,
  runsServerPort,
  runsWebPort,
  serverPort,
  webPort,
} from './ports.js';

// Compare 的 e2e 数据目录，由种子脚本清空后写入
const compareDataDir = '.work/e2e/compare-data';
// Runs 的 e2e 数据目录：保留在多次运行之间，其中有导入的 W4 端到端 run 与测试中构建的 variant
const runsDataDir = '.work/e2e/runs-data';
// 环境检查的 e2e 数据目录：每次删除重建，Settings 从默认值开始
const environmentDataDir = '.work/e2e/environment-data';
// Sessions 的服务端每次使用删除重建的数据库
const dbDir = path.resolve(import.meta.dirname, '.work/e2e-db');
// Sessions 的来源目录：每次由种子脚本删除重建，放入真实 run 的 session
const projectsDir = path.resolve(import.meta.dirname, '.work/e2e/projects');
// chromium 项目服务端的数据目录（variants.spec 在这里构建 variant）：保留在多次运行之间，wf runtime 只编译一次。
// 仓库根目录的 data/ 是用户实例的数据目录，e2e 不写进去
const chromiumDataDir = path.resolve(import.meta.dirname, '.work/e2e/chromium-data');

// 两个开发服务器继承本进程的 WFD_PORT、WFD_WEB_PORT；
// compare 项目另起一对服务，服务端读取种子脚本写入的专用数据目录
export default defineConfig({
  testDir: './e2e',
  outputDir: './.work/playwright/results',
  reporter: [['list'], ['html', { outputFolder: './.work/playwright/report', open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: [
        'compare.spec.ts',
        'runs.spec.ts',
        'variants-imported.spec.ts',
        'details.spec.ts',
        'live.spec.ts',
        'environment.spec.ts',
        'compare-empty.spec.ts',
        'guide/**',
      ],
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://127.0.0.1:${String(webPort)}`,
        viewport: { width: 1600, height: 1000 },
      },
    },
    {
      name: 'compare',
      testMatch: 'compare.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://127.0.0.1:${String(compareWebPort)}`,
      },
    },
    {
      name: 'runs',
      testMatch: ['runs.spec.ts', 'variants-imported.spec.ts', 'details.spec.ts', 'live.spec.ts'],
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://127.0.0.1:${String(runsWebPort)}`,
        viewport: { width: 1600, height: 1000 },
      },
    },
    {
      name: 'environment',
      // 数据目录每次删除重建：Compare 的空状态也在这里测试
      testMatch: ['environment.spec.ts', 'compare-empty.spec.ts'],
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://127.0.0.1:${String(environmentServerPort)}`,
        viewport: { width: 1600, height: 1000 },
      },
    },
  ],
  webServer: [
    {
      command: `rm -rf ${dbDir} && pnpm --filter @wf-dashboard/server prepare:sessions-e2e && pnpm --filter @wf-dashboard/server dev`,
      url: `http://127.0.0.1:${String(serverPort)}/api/health`,
      env: {
        WFD_DATA_DIR: chromiumDataDir,
        WFD_DB_PATH: path.join(dbDir, 'db.sqlite'),
        WFD_CLAUDE_PROJECTS: projectsDir,
      },
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @wf-dashboard/web dev',
      url: `http://127.0.0.1:${String(webPort)}`,
      // 端口被其他 worktree 的页面占用时报错，不测试别人的页面
      reuseExistingServer: false,
    },
    {
      command:
        'pnpm --filter @wf-dashboard/server seed:compare-e2e && pnpm --filter @wf-dashboard/server exec tsx src/main.ts',
      url: `http://127.0.0.1:${String(compareServerPort)}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { WFD_DATA_DIR: compareDataDir, WFD_PORT: String(compareServerPort) },
    },
    {
      command: 'pnpm --filter @wf-dashboard/web dev',
      url: `http://127.0.0.1:${String(compareWebPort)}`,
      reuseExistingServer: false,
      env: { WFD_PORT: String(compareServerPort), WFD_WEB_PORT: String(compareWebPort) },
    },
    {
      command:
        'pnpm --filter @wf-dashboard/server prepare:runs-e2e && pnpm --filter @wf-dashboard/server exec tsx src/main.ts',
      url: `http://127.0.0.1:${String(runsServerPort)}/api/health`,
      reuseExistingServer: false,
      timeout: 600_000,
      env: {
        WFD_DATA_DIR: runsDataDir,
        WFD_PORT: String(runsServerPort),
      },
    },
    {
      command: 'pnpm --filter @wf-dashboard/web dev',
      url: `http://127.0.0.1:${String(runsWebPort)}`,
      reuseExistingServer: false,
      env: { WFD_PORT: String(runsServerPort), WFD_WEB_PORT: String(runsWebPort) },
    },
    {
      // 与 pnpm start 相同：构建后只开服务端一个端口
      command: `rm -rf ${environmentDataDir} && pnpm build && pnpm --filter @wf-dashboard/server start`,
      url: `http://127.0.0.1:${String(environmentServerPort)}/api/health`,
      reuseExistingServer: false,
      timeout: 300_000,
      env: {
        WFD_DATA_DIR: environmentDataDir,
        WFD_PORT: String(environmentServerPort),
      },
    },
  ],
});
