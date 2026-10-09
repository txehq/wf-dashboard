import { defineConfig, devices } from '@playwright/test';
import { serverPort, webPort } from './ports.js';

// 两个开发服务器继承本进程的 WFD_PORT、WFD_WEB_PORT
export default defineConfig({
  testDir: './e2e',
  outputDir: './.work/playwright/results',
  reporter: [['list'], ['html', { outputFolder: './.work/playwright/report', open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${String(webPort)}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
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
  ],
});
