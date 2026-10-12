import { defineConfig, devices } from '@playwright/test';
import { e2eLocalReposDir } from './e2e/local-repos.js';
import { type Service, webServersFor } from './e2e/services.js';
import { compareWebPort, liveItemsWebPort, runsWebPort, webPort } from './ports.js';
import { guardBasicTier } from './server/test/setup/basic-tier.js';
import { guardGithub } from './server/test/setup/github-guard.js';

// 基础档的 e2e（pnpm e2e）：使用种子数据与导入的真实 run，服务端不调用真实模型、claude 与 Codex，不写 Linear，
// 不依赖网络。所有服务与测试进程继承这里的环境（webServer 在 globalSetup 之前启动，所以在加载配置时设置）：
// claude、codex、gh 与 gateway 的请求一律失败（页面加载时的环境检查也在其中）；
// run 与交互的仓库建在本地 bare 仓库中。其余 spec 在 playwright.real.config.ts（pnpm e2e:real）
guardGithub();
guardBasicTier({ offline: true });
process.env.WFD_LOCAL_REPOS_DIR = e2eLocalReposDir;

// 同一个 spec 中真实调用 judge 或真实运行的用例在真实档，按标题排除
const realTests = [/让 LLM 起草 rubric/, /粘贴工单地址导入/, /真实运行/];

const projectServices: Record<string, Service[]> = {
  chromium: ['sessionsServer', 'web'],
  compare: ['compareServer', 'compareWeb'],
  runs: ['runsServer', 'runsWeb'],
  'live-items': ['liveItemsServer', 'liveItemsWeb'],
};

export default defineConfig({
  testDir: './e2e',
  outputDir: './.work/playwright/results',
  reporter: [['list'], ['html', { outputFolder: './.work/playwright/report', open: 'never' }]],
  // 多个 worktree 同时运行测试时 CPU 排队：渲染 37 MB 的 f0aca373 与保存 task 的用例超过默认的 30 秒与 5 秒
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    trace: 'retain-on-failure',
  },
  grepInvert: realTests,
  projects: [
    {
      name: 'chromium',
      // compare-empty 用这里每次删除重建的数据库：其中没有已评分的 run
      testMatch: [
        'home.spec.ts',
        'sessions.spec.ts',
        'tasks.spec.ts',
        'tasks-import.spec.ts',
        'variants.spec.ts',
        'workflows.spec.ts',
        'compare-empty.spec.ts',
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
      // W4 端到端导入的已结束 run（prepare-runs-e2e）
      name: 'runs',
      testMatch: ['runs.spec.ts', 'variants-imported.spec.ts', 'details.spec.ts'],
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://127.0.0.1:${String(runsWebPort)}`,
        viewport: { width: 1600, height: 1000 },
      },
    },
    {
      // 交互项的关闭、删除、导入选择框与 Sessions 的 Live 按钮：只导入不启动，不调用 claude
      name: 'live-items',
      testMatch: 'live-items.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://127.0.0.1:${String(liveItemsWebPort)}`,
        viewport: { width: 1600, height: 1000 },
      },
    },
  ],
  webServer: webServersFor(projectServices),
});
