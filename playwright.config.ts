import { defineConfig, devices } from '@playwright/test';
import { compareServerPort, compareWebPort, serverPort, webPort } from './ports.js';

// Compare 的 e2e 数据目录，由种子脚本清空后写入
const compareDataDir = '.work/e2e/compare-data';

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
      testIgnore: 'compare.spec.ts',
      use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${String(webPort)}` },
    },
    {
      name: 'compare',
      testMatch: 'compare.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://127.0.0.1:${String(compareWebPort)}`,
      },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @wf-dashboard/server dev',
      url: `http://127.0.0.1:${String(serverPort)}/api/health`,
      reuseExistingServer: true,
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
  ],
});
