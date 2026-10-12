import { defineConfig, devices } from '@playwright/test';
import { e2eLocalReposDir } from './e2e/local-repos.js';
import { type Service, webServersFor } from './e2e/services.js';
import { analysesWebPort, environmentServerPort, runsWebPort, webPort } from './ports.js';
import { guardGithub } from './server/test/setup/github-guard.js';

// 真实档的 e2e（pnpm e2e:real [文件…]）：服务端真实调用 judge、claude、Codex 或 Linear MCP 的 spec 与用例。
// 只运行覆盖改动的那几个文件；e2e/run.ts 只启动选中的 project 用到的服务。
// 与 pnpm e2e 相同：gh 在 GitHub 上创建或修改对象的命令一律报错，run 与交互的仓库建在本地 bare 仓库中
guardGithub();
process.env.WFD_LOCAL_REPOS_DIR = e2eLocalReposDir;

const projectServices: Record<string, Service[]> = {
  chromium: ['sessionsServer', 'web'],
  runs: ['runsServer', 'runsWeb'],
  live: ['runsServer', 'runsWeb'],
  environment: ['environmentServer'],
  analyses: ['analysesServer', 'analysesWeb'],
};

export default defineConfig({
  testDir: './e2e',
  outputDir: './.work/playwright/real-results',
  reporter: [['list'], ['html', { outputFolder: './.work/playwright/real-report', open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    {
      // 真实调用 judge 的用例：起草 rubric、导入工单时确定验收标准（同一 spec 的其余用例在基础档）
      name: 'chromium',
      testMatch: ['tasks.spec.ts', 'tasks-import.spec.ts'],
      grep: [/让 LLM 起草 rubric/, /粘贴工单地址导入/],
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
      testMatch: 'live.spec.ts',
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
  webServer: webServersFor(projectServices),
});
