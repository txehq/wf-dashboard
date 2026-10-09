import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  outputDir: './.work/playwright/results',
  reporter: [['list'], ['html', { outputFolder: './.work/playwright/report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @wf-dashboard/server dev',
      url: 'http://127.0.0.1:7317/api/health',
      reuseExistingServer: true,
    },
    {
      command: 'pnpm --filter @wf-dashboard/web dev',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: true,
    },
  ],
});
