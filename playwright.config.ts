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
// Sessions 的阶段判定从未判定的状态开始：服务端每次使用删除重建的数据库
const dbDir = path.resolve(import.meta.dirname, '.work/e2e-db');

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
        'environment.spec.ts',
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
      testMatch: ['runs.spec.ts', 'variants-imported.spec.ts', 'details.spec.ts'],
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://127.0.0.1:${String(runsWebPort)}`,
        viewport: { width: 1600, height: 1000 },
      },
    },
    {
      name: 'environment',
      testMatch: 'environment.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://127.0.0.1:${String(environmentServerPort)}`,
        viewport: { width: 1600, height: 1000 },
      },
    },
  ],
  webServer: [
    {
      command: `rm -rf ${dbDir} && pnpm --filter @wf-dashboard/server dev`,
      url: `http://127.0.0.1:${String(serverPort)}/api/health`,
      // Sessions 的判定在 e2e 中使用 Sonnet
      env: { WFD_DB_PATH: path.join(dbDir, 'db.sqlite'), WFD_STAGE_CHECK_MODEL: 'claude-sonnet-5' },
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @wf-dashboard/web dev',
      url: `http://127.0.0.1:${String(webPort)}`,
      reuseExistingServer: true,
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
        WFD_STAGE_CHECK_MODEL: 'claude-sonnet-5',
      },
    },
    {
      command: 'pnpm --filter @wf-dashboard/web dev',
      url: `http://127.0.0.1:${String(runsWebPort)}`,
      reuseExistingServer: false,
      env: { WFD_PORT: String(runsServerPort), WFD_WEB_PORT: String(runsWebPort) },
    },
    {
      // 与 pnpm start 相同：构建后只开服务端一个端口；阶段判定用 W4 中 gateway 上没有渠道的模型名，
      // 环境清单中有一项真实未通过
      command: `rm -rf ${environmentDataDir} && pnpm build && pnpm --filter @wf-dashboard/server start`,
      url: `http://127.0.0.1:${String(environmentServerPort)}/api/health`,
      reuseExistingServer: false,
      timeout: 300_000,
      env: {
        WFD_DATA_DIR: environmentDataDir,
        WFD_PORT: String(environmentServerPort),
        WFD_STAGE_CHECK_MODEL: 'claude-haiku-4-5-20251001-cc',
      },
    },
  ],
});
