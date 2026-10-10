import { defineConfig, devices } from '@playwright/test';
import { guideServerPort } from './ports.js';

// 使用手册的截图：pnpm e2e:guide。与 pnpm start 相同，构建后由服务端一个端口提供页面与 API；
// 数据目录导入 W4 端到端留下的真实 run。其中一步真实发起一个 lfg run（在 txehq 建仓库、写 vault），接管后取消
const guideDataDir = '.work/guide/data';

export default defineConfig({
  testDir: './e2e/guide',
  outputDir: './.work/playwright/guide-results',
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${String(guideServerPort)}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    actionTimeout: 60_000,
  },
  webServer: {
    command:
      'pnpm build && pnpm --filter @wf-dashboard/server prepare:runs-e2e && pnpm --filter @wf-dashboard/server start',
    url: `http://127.0.0.1:${String(guideServerPort)}/api/health`,
    reuseExistingServer: false,
    timeout: 900_000,
    env: { WFD_DATA_DIR: guideDataDir, WFD_PORT: String(guideServerPort) },
  },
});
