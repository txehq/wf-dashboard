import { defineConfig, devices } from '@playwright/test';
import { e2eLocalReposDir } from './e2e/local-repos.js';
import { e2eGroupName, realProjectServices, webServersFor } from './e2e/services.js';
import { e2eVaultDir } from './e2e/vault.js';
import { analysesWebPort, environmentServerPort, runsWebPort, webPort } from './ports.js';
import { guardGithub } from './server/test/setup/github-guard.js';

// 真实档的 e2e（pnpm e2e:real [文件…]）：服务端真实调用 judge、claude、Codex 或 Linear MCP 的 spec 与用例。
// 只运行覆盖改动的那几个文件；e2e/run.ts 按用到的服务把选中的 project 分组，一组一组地运行。
// 与 pnpm e2e 相同：gh 在 GitHub 上创建或修改对象的命令一律报错，run 与交互的仓库建在本地 bare 仓库中
guardGithub();
process.env.WFD_LOCAL_REPOS_DIR = e2eLocalReposDir;
process.env.MAGI_VAULT = e2eVaultDir;
// 这些服务读得到 GitHub：不检查 txe-workflow 的最新版，不在各自的数据目录中自动导入、编译 wf（Contracts 29.1）
process.env.WFD_RELEASE_CHECK = 'off';

export default defineConfig({
  testDir: './e2e',
  outputDir: `./.work/playwright/real-results/${e2eGroupName}`,
  reporter: [
    ['list'],
    ['html', { outputFolder: `./.work/playwright/real-report/${e2eGroupName}`, open: 'never' }],
  ],
  use: {
    trace: 'retain-on-failure',
  },
  // 与基础档相同，同时运行 1 个用例（playwright.config.ts）
  workers: 1,
  projects: [
    {
      // 真实调用 judge 的用例：起草 rubric、导入工单时确定验收标准（同一 spec 的其余用例在基础档）；
      // Codex 草稿保存时的真实构建（不调用模型，Codex 仍是替身命令）
      name: 'chromium',
      testMatch: ['tasks.spec.ts', 'tasks-import.spec.ts', 'codex-drafts.spec.ts'],
      grep: [/让 LLM 起草 rubric/, /粘贴工单地址导入/, /真实构建/],
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://127.0.0.1:${String(webPort)}`,
        viewport: { width: 1600, height: 1000 },
      },
    },
    {
      // 真实发起 lfg run、模拟用户回答（同一 spec 中已结束 run 的用例在基础档）
      name: 'runs',
      testMatch: 'runs.spec.ts',
      grep: /真实运行/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://127.0.0.1:${String(runsWebPort)}`,
        viewport: { width: 1600, height: 1000 },
      },
    },
    {
      // 真实 claude 的交互终端与模拟用户驾驶
      name: 'live',
      testMatch: ['live.spec.ts', 'live-interrupt.spec.ts'],
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://127.0.0.1:${String(runsWebPort)}`,
        viewport: { width: 1600, height: 1000 },
      },
    },
    {
      // 真实执行全部环境检查（claude、gateway、codex exec、Linear MCP）；服务端以 pnpm start 的方式启动
      name: 'environment',
      testMatch: 'environment.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://127.0.0.1:${String(environmentServerPort)}`,
        viewport: { width: 1600, height: 1000 },
      },
    },
    {
      // 真实引擎分析真实 session，单个测试的时限在 spec 中加长
      name: 'analyses',
      testMatch: 'analyses.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://127.0.0.1:${String(analysesWebPort)}`,
        viewport: { width: 1600, height: 1000 },
      },
    },
  ],
  webServer: webServersFor(realProjectServices),
});
