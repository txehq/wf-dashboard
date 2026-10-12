import { defineConfig, devices } from '@playwright/test';
import { e2eLocalReposDir } from './e2e/local-repos.js';
import { guideServerPort } from './ports.js';
import { guardGithub } from './server/test/setup/github-guard.js';

// 使用手册的截图：pnpm e2e:guide。与 pnpm start 相同，构建后由服务端一个端口提供页面与 API；
// 数据目录导入 W4 端到端留下的真实 run。其中一步真实发起一个 lfg run（仓库建在本地 bare 仓库、写 vault），接管后取消。
// 与 pnpm e2e 相同：gh 在 GitHub 上创建或修改对象的命令一律报错
guardGithub();
process.env.WFD_LOCAL_REPOS_DIR = e2eLocalReposDir;
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
