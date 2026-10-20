import path from 'node:path';
import type { PlaywrightTestConfig } from '@playwright/test';
import {
  analysesServerPort,
  analysesWebPort,
  analysisWorkflowServerPort,
  analysisWorkflowWebPort,
  compareServerPort,
  compareWebPort,
  environmentServerPort,
  liveFullscreenServerPort,
  liveFullscreenWebPort,
  liveItemsServerPort,
  liveItemsWebPort,
  resumeDialogServerPort,
  resumeDialogWebPort,
  runsServerPort,
  runsWebPort,
  serverPort,
  variantRenameServerPort,
  variantRenameWebPort,
  liveAutoStopServerPort,
  liveAutoStopWebPort,
  magiAgentServerPort,
  magiAgentWebPort,
  webPort,
} from '../ports.js';

type WebServer = Exclude<NonNullable<PlaywrightTestConfig['webServer']>, unknown[]>;

const root = path.resolve(import.meta.dirname, '..');
// Compare 的 e2e 数据目录，由种子脚本清空后写入
const compareDataDir = '.work/e2e/compare-data';
// Runs 的 e2e 数据目录：保留在多次运行之间，其中有导入的 W4 端到端 run 与测试中构建的 variant
const runsDataDir = '.work/e2e/runs-data';
// Runs 服务端"本机配置"的来源目录：每次由 prepare-runs-e2e 删除重建，放入真实 session f0aca373（详情页的对话区）
export const runsProjectsDir = path.join(root, '.work/e2e/runs-projects');
// 环境检查的 e2e 数据目录：每次删除重建，Settings 从默认值开始
const environmentDataDir = '.work/e2e/environment-data';
// Sessions 的服务端每次使用删除重建的数据库
const dbDir = path.join(root, '.work/e2e-db');
// Sessions 的来源目录：每次由种子脚本删除重建，放入真实 run 的 session
const projectsDir = path.join(root, '.work/e2e/projects');
// 本机 Codex 的 CODEX_HOME（Contracts 25.1）：每次由 prepare-sessions-e2e 删除重建，放入真实 rollout 的样本
export const e2eCodexHome = path.join(root, '.work/e2e/codex-home');
// chromium 项目服务端的数据目录（variants.spec 在这里构建 variant）：保留在多次运行之间，wf runtime 只编译一次。
// 仓库根目录的 data/ 是用户实例的数据目录，e2e 不写进去
const chromiumDataDir = path.join(root, '.work/e2e/chromium-data');
// chromium 项目服务端"本机配置"的 HOME：测试在其中放入要用的 skill，不读用户真实的 ~/.claude
export const chromiumHome = path.join(root, '.work/e2e/chromium-home');
// 分析页面的数据目录与来源目录：每次由 prepare-analyses-e2e 删除重建（两个真实 run 的 session 与 9f2bed6 的基线）
const analysesDataDir = '.work/e2e/analyses-data';
const analysesProjectsDir = path.join(root, '.work/e2e/analyses/projects');
// 交互项 e2e 的数据目录与来源目录：每次删除重建
export const liveItemsDir = path.join(root, '.work/e2e/live-items');
export const liveItemsProjectsDir = path.join(liveItemsDir, 'projects');
// Live 全屏 e2e 的数据目录、来源目录与"本机配置"的 HOME：每次删除重建
export const liveFullscreenDir = path.join(root, '.work/e2e/live-fullscreen');
export const liveFullscreenProjectsDir = path.join(liveFullscreenDir, 'projects');
// 关闭页面后自动结束 e2e 的数据目录、来源目录与"本机配置"的 HOME：每次删除重建
export const liveAutoStopDir = path.join(root, '.work/e2e/live-auto-stop');
export const liveAutoStopProjectsDir = path.join(liveAutoStopDir, 'projects');
// 这个 spec 中没有页面连接持续多久后结束交互进程
export const liveAutoStopMs = 3000;
// Magi Agent e2e 的数据目录、"本机配置"的 HOME、主仓库（本地 git 仓库）与它旁边的 worktree：每次删除重建
export const magiAgentDir = path.join(root, '.work/e2e/magi-agent');
export const magiAgentRepo = path.join(magiAgentDir, 'repo');
export const magiAgentWorktree = path.join(magiAgentDir, 'wf-dashboard-magi-agent');
// resume 对话框 e2e 的数据目录、来源目录与"本机配置"的 HOME：每次删除重建，不碰真实的 ~/.claude
export const resumeDialogDir = path.join(root, '.work/e2e/resume-dialog');
export const resumeDialogProjectsDir = path.join(resumeDialogDir, 'projects');
export const resumeDialogHome = path.join(resumeDialogDir, 'home');
// variant 改名 e2e 的数据目录、来源目录与"本机配置"的 HOME：每次删除重建
export const variantRenameDir = path.join(root, '.work/e2e/variant-rename');
export const variantRenameProjectsDir = path.join(variantRenameDir, 'projects');
// Codex 草稿（Contracts 第 17 节）：skill 的来源是 prepare-codex-skills-e2e 建的本地 git 仓库，Codex 换成测试中的
// 替身命令（只验证页面与 API）
const codexSkillsDir = path.join(root, '.work/e2e/codex-skills');
const codexEnv = {
  WFD_CODEX_BIN: path.join(root, 'server/test/fixtures/codex/codex-stand-in.mjs'),
  WFD_CODEX_SKILL_SOURCES: JSON.stringify(
    ['find-skills', 'skill-creator', 'writing-for-agents'].map((name) => ({
      name,
      source: path.join(codexSkillsDir, name),
    })),
  ),
};
// 分析由 workflow 驱动（Contracts 19.2、19.3）：数据目录与 skill 来源每次由 prepare-analysis-workflow-e2e 删除重建；
// skill 来源与 chromium 的分开，两个服务同时启动时不互相删除
export const analysisWorkflowDir = path.join(root, '.work/e2e/analysis-workflow');
const analysisWorkflowSkills = path.join(analysisWorkflowDir, 'codex-skills');
// 页面的构建产物：e2e/run.ts 每次 e2e 先 vite build 一次到这里，各 project 的页面服务用 vite preview 提供同一份产物，
// 按端口经 /api 代理（含 WebSocket）到各自的服务端（web/vite.config.ts 的 preview）
export const e2eWebDist = path.join(root, '.work/e2e/web-dist');
const webPreview = `pnpm --filter @wf-dashboard/web exec vite preview --outDir ${e2eWebDist}`;

// 各 project 用到的服务。chromium 的服务端与页面继承本进程的 WFD_PORT、WFD_WEB_PORT；
// 其余几对服务读取各自的专用数据目录，端口见 ports.ts
export const services = {
  sessionsServer: {
    command: `rm -rf ${dbDir} && pnpm --filter @wf-dashboard/server prepare:sessions-e2e && pnpm --filter @wf-dashboard/server prepare:codex-skills-e2e && pnpm --filter @wf-dashboard/server exec tsx src/main.ts`,
    url: `http://127.0.0.1:${String(serverPort)}/api/health`,
    env: {
      WFD_DATA_DIR: chromiumDataDir,
      WFD_DB_PATH: path.join(dbDir, 'db.sqlite'),
      WFD_CLAUDE_PROJECTS: projectsDir,
      WFD_LOCAL_HOME: chromiumHome,
      ...codexEnv,
      // Codex 替身整屏重画、最后一行是状态行（设计会话的终端最后一行是否可见，W80）
      STAND_IN_STATUS_LINE: '1',
    },
    reuseExistingServer: false,
  },
  web: {
    command: webPreview,
    url: `http://127.0.0.1:${String(webPort)}`,
    // 端口被其他 worktree 的页面占用时报错，不测试别人的页面
    reuseExistingServer: false,
  },
  compareServer: {
    command:
      'pnpm --filter @wf-dashboard/server seed:compare-e2e && pnpm --filter @wf-dashboard/server exec tsx src/main.ts',
    url: `http://127.0.0.1:${String(compareServerPort)}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { WFD_DATA_DIR: compareDataDir, WFD_PORT: String(compareServerPort) },
  },
  compareWeb: {
    command: webPreview,
    url: `http://127.0.0.1:${String(compareWebPort)}`,
    reuseExistingServer: false,
    env: { WFD_PORT: String(compareServerPort), WFD_WEB_PORT: String(compareWebPort) },
  },
  runsServer: {
    command:
      'pnpm --filter @wf-dashboard/server prepare:runs-e2e && pnpm --filter @wf-dashboard/server exec tsx src/main.ts',
    url: `http://127.0.0.1:${String(runsServerPort)}/api/health`,
    reuseExistingServer: false,
    timeout: 600_000,
    env: {
      WFD_DATA_DIR: runsDataDir,
      WFD_CLAUDE_PROJECTS: runsProjectsDir,
      WFD_PORT: String(runsServerPort),
    },
  },
  runsWeb: {
    command: webPreview,
    url: `http://127.0.0.1:${String(runsWebPort)}`,
    reuseExistingServer: false,
    env: { WFD_PORT: String(runsServerPort), WFD_WEB_PORT: String(runsWebPort) },
  },
  environmentServer: {
    // 与 pnpm start 相同：构建后只开服务端一个端口
    command: `rm -rf ${environmentDataDir} && pnpm build && pnpm --filter @wf-dashboard/server start`,
    url: `http://127.0.0.1:${String(environmentServerPort)}/api/health`,
    reuseExistingServer: false,
    timeout: 300_000,
    env: { WFD_DATA_DIR: environmentDataDir, WFD_PORT: String(environmentServerPort) },
  },
  analysesServer: {
    command:
      'pnpm --filter @wf-dashboard/server prepare:analyses-e2e && pnpm --filter @wf-dashboard/server exec tsx src/main.ts',
    url: `http://127.0.0.1:${String(analysesServerPort)}/api/health`,
    reuseExistingServer: false,
    timeout: 300_000,
    env: {
      WFD_DATA_DIR: analysesDataDir,
      WFD_CLAUDE_PROJECTS: analysesProjectsDir,
      WFD_PORT: String(analysesServerPort),
    },
  },
  analysesWeb: {
    command: webPreview,
    url: `http://127.0.0.1:${String(analysesWebPort)}`,
    reuseExistingServer: false,
    env: { WFD_PORT: String(analysesServerPort), WFD_WEB_PORT: String(analysesWebPort) },
  },
  liveItemsServer: {
    // 数据目录与来源目录每次删除重建；来源目录下的 session 目录由 live-items.spec 放入
    command: `rm -rf ${liveItemsDir} && mkdir -p ${liveItemsProjectsDir} && pnpm --filter @wf-dashboard/server exec tsx src/main.ts`,
    url: `http://127.0.0.1:${String(liveItemsServerPort)}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      WFD_DATA_DIR: path.join(liveItemsDir, 'data'),
      WFD_CLAUDE_PROJECTS: liveItemsProjectsDir,
      WFD_PORT: String(liveItemsServerPort),
    },
  },
  liveItemsWeb: {
    command: webPreview,
    url: `http://127.0.0.1:${String(liveItemsWebPort)}`,
    reuseExistingServer: false,
    env: { WFD_PORT: String(liveItemsServerPort), WFD_WEB_PORT: String(liveItemsWebPort) },
  },
  liveFullscreenServer: {
    // 数据目录、来源目录与"本机配置"的 HOME 每次删除重建；Claude Code 换成回显按键与终端尺寸的替身
    command: `rm -rf ${liveFullscreenDir} && mkdir -p ${liveFullscreenProjectsDir} && pnpm --filter @wf-dashboard/server exec tsx src/main.ts`,
    url: `http://127.0.0.1:${String(liveFullscreenServerPort)}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      WFD_DATA_DIR: path.join(liveFullscreenDir, 'data'),
      WFD_CLAUDE_PROJECTS: liveFullscreenProjectsDir,
      WFD_PORT: String(liveFullscreenServerPort),
      WFD_CLAUDE_BIN: path.join(root, 'server/test/fixtures/live/claude-stand-in.mjs'),
      WFD_LOCAL_HOME: path.join(liveFullscreenDir, 'home'),
      // 替身整屏重画、最后一行是状态行（终端最后一行是否可见，W80）
      STAND_IN_STATUS_LINE: '1',
    },
  },
  liveAutoStopServer: {
    command: `rm -rf ${liveAutoStopDir} && mkdir -p ${liveAutoStopProjectsDir} && pnpm --filter @wf-dashboard/server exec tsx src/main.ts`,
    url: `http://127.0.0.1:${String(liveAutoStopServerPort)}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      WFD_DATA_DIR: path.join(liveAutoStopDir, 'data'),
      WFD_CLAUDE_PROJECTS: liveAutoStopProjectsDir,
      WFD_PORT: String(liveAutoStopServerPort),
      WFD_CLAUDE_BIN: path.join(root, 'server/test/fixtures/live/claude-stand-in.mjs'),
      WFD_LOCAL_HOME: path.join(liveAutoStopDir, 'home'),
      WFD_LIVE_AUTO_STOP_MS: String(liveAutoStopMs),
    },
  },
  liveAutoStopWeb: {
    command: webPreview,
    url: `http://127.0.0.1:${String(liveAutoStopWebPort)}`,
    reuseExistingServer: false,
    env: { WFD_PORT: String(liveAutoStopServerPort), WFD_WEB_PORT: String(liveAutoStopWebPort) },
  },
  magiAgentServer: {
    // Claude Code 与 Codex 都是替身命令；部署的检查换成一条很快的 node 命令
    command: `rm -rf ${magiAgentDir} && mkdir -p ${path.join(magiAgentDir, 'projects')} && pnpm --filter @wf-dashboard/server prepare:magi-agent-e2e ${magiAgentRepo} && pnpm --filter @wf-dashboard/server exec tsx src/main.ts`,
    url: `http://127.0.0.1:${String(magiAgentServerPort)}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      WFD_DATA_DIR: path.join(magiAgentDir, 'data'),
      WFD_CLAUDE_PROJECTS: path.join(magiAgentDir, 'projects'),
      WFD_PORT: String(magiAgentServerPort),
      WFD_CLAUDE_BIN: path.join(root, 'server/test/fixtures/live/claude-stand-in.mjs'),
      WFD_CODEX_BIN: codexEnv.WFD_CODEX_BIN,
      WFD_LOCAL_HOME: path.join(magiAgentDir, 'home'),
      WFD_MAGI_REPO: magiAgentRepo,
      WFD_MAGI_WORKTREE: magiAgentWorktree,
      WFD_MAGI_CHECK: JSON.stringify(['node', '-e', "console.log('检查通过')"]),
    },
  },
  magiAgentWeb: {
    command: webPreview,
    url: `http://127.0.0.1:${String(magiAgentWebPort)}`,
    reuseExistingServer: false,
    env: { WFD_PORT: String(magiAgentServerPort), WFD_WEB_PORT: String(magiAgentWebPort) },
  },
  liveFullscreenWeb: {
    command: webPreview,
    url: `http://127.0.0.1:${String(liveFullscreenWebPort)}`,
    reuseExistingServer: false,
    env: {
      WFD_PORT: String(liveFullscreenServerPort),
      WFD_WEB_PORT: String(liveFullscreenWebPort),
    },
  },
  resumeDialogServer: {
    command: `rm -rf ${resumeDialogDir} && mkdir -p ${resumeDialogProjectsDir} ${resumeDialogHome} && pnpm --filter @wf-dashboard/server exec tsx src/main.ts`,
    url: `http://127.0.0.1:${String(resumeDialogServerPort)}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      WFD_DATA_DIR: path.join(resumeDialogDir, 'data'),
      WFD_CLAUDE_PROJECTS: resumeDialogProjectsDir,
      WFD_PORT: String(resumeDialogServerPort),
      WFD_LOCAL_HOME: resumeDialogHome,
    },
  },
  resumeDialogWeb: {
    command: webPreview,
    url: `http://127.0.0.1:${String(resumeDialogWebPort)}`,
    reuseExistingServer: false,
    env: { WFD_PORT: String(resumeDialogServerPort), WFD_WEB_PORT: String(resumeDialogWebPort) },
  },
  analysisWorkflowServer: {
    command: `pnpm --filter @wf-dashboard/server prepare:analysis-workflow-e2e ${analysisWorkflowSkills} && pnpm --filter @wf-dashboard/server exec tsx src/main.ts`,
    url: `http://127.0.0.1:${String(analysisWorkflowServerPort)}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      WFD_DATA_DIR: path.join(analysisWorkflowDir, 'data'),
      WFD_CLAUDE_PROJECTS: path.join(analysisWorkflowDir, 'projects'),
      WFD_PORT: String(analysisWorkflowServerPort),
      WFD_CODEX_BIN: codexEnv.WFD_CODEX_BIN,
      // 选 Claude Code 优化时的会话（Contracts 22.2）：换成回显按键的替身，只验证页面、终端与保存
      WFD_CLAUDE_BIN: path.join(root, 'server/test/fixtures/live/claude-stand-in.mjs'),
      WFD_CODEX_SKILL_SOURCES: JSON.stringify(
        ['find-skills', 'skill-creator', 'writing-for-agents'].map((name) => ({
          name,
          source: path.join(analysisWorkflowSkills, name),
        })),
      ),
    },
  },
  analysisWorkflowWeb: {
    command: webPreview,
    url: `http://127.0.0.1:${String(analysisWorkflowWebPort)}`,
    reuseExistingServer: false,
    env: {
      WFD_PORT: String(analysisWorkflowServerPort),
      WFD_WEB_PORT: String(analysisWorkflowWebPort),
    },
  },
  variantRenameServer: {
    // 与 Live 全屏相同：每次删除重建，Claude Code 换成替身命令；单独一对服务，交互项不混进别的用例的列表
    command: `rm -rf ${variantRenameDir} && mkdir -p ${variantRenameProjectsDir} && pnpm --filter @wf-dashboard/server exec tsx src/main.ts`,
    url: `http://127.0.0.1:${String(variantRenameServerPort)}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      WFD_DATA_DIR: path.join(variantRenameDir, 'data'),
      WFD_CLAUDE_PROJECTS: variantRenameProjectsDir,
      WFD_PORT: String(variantRenameServerPort),
      WFD_CLAUDE_BIN: path.join(root, 'server/test/fixtures/live/claude-stand-in.mjs'),
      WFD_LOCAL_HOME: path.join(variantRenameDir, 'home'),
    },
  },
  variantRenameWeb: {
    command: webPreview,
    url: `http://127.0.0.1:${String(variantRenameWebPort)}`,
    reuseExistingServer: false,
    env: {
      WFD_PORT: String(variantRenameServerPort),
      WFD_WEB_PORT: String(variantRenameWebPort),
    },
  },
} satisfies Record<string, WebServer>;

export type Service = keyof typeof services;

// 两份配置中各 project 用到的服务
export const basicProjectServices: Record<string, Service[]> = {
  chromium: ['sessionsServer', 'web'],
  compare: ['compareServer', 'compareWeb'],
  runs: ['runsServer', 'runsWeb'],
  'live-items': ['liveItemsServer', 'liveItemsWeb'],
  'live-fullscreen': ['liveFullscreenServer', 'liveFullscreenWeb'],
  'analysis-workflow': ['analysisWorkflowServer', 'analysisWorkflowWeb'],
  'live-purpose': ['analysisWorkflowServer', 'analysisWorkflowWeb'],
  'resume-dialog': ['resumeDialogServer', 'resumeDialogWeb'],
  'variant-rename': ['variantRenameServer', 'variantRenameWeb'],
  'live-auto-stop': ['liveAutoStopServer', 'liveAutoStopWeb'],
  'magi-agent': ['magiAgentServer', 'magiAgentWeb'],
};
export const realProjectServices: Record<string, Service[]> = {
  chromium: ['sessionsServer', 'web'],
  runs: ['runsServer', 'runsWeb'],
  live: ['runsServer', 'runsWeb'],
  environment: ['environmentServer'],
  analyses: ['analysesServer', 'analysesWeb'],
};

// e2e/run.ts 把选中的 project 按用到的服务分组，一组一组地运行：共用服务的 project（例如 analysis-workflow 与
// live-purpose）在同一组，组的顺序与 project 在表中的顺序相同。同一时间只有一组的服务端与页面在运行
export function projectGroups(projects: Record<string, Service[]>, selected: string[]) {
  let groups: { projects: string[]; services: Set<Service> }[] = [];
  for (const [name, list] of Object.entries(projects)) {
    if (!selected.includes(name)) continue;
    // 与这个 project 共用服务的组合成一组，放在其中最早的一组的位置
    const joined = groups.filter((g) => list.some((s) => g.services.has(s)));
    const merged = {
      projects: [...joined.flatMap((g) => g.projects), name],
      services: new Set([...joined.flatMap((g) => [...g.services]), ...list]),
    };
    const first = joined[0];
    groups = groups
      .filter((g) => g === first || !joined.includes(g))
      .map((g) => (g === first ? merged : g));
    if (first === undefined) groups.push(merged);
  }
  return groups.map((g) => g.projects);
}

// 这一组的 project：e2e/run.ts 经 WFD_E2E_PROJECTS 传进来；直接运行 playwright test 时没有这个变量，即全部 project
function selectedNames(projects: Record<string, Service[]>) {
  const raw = process.env.WFD_E2E_PROJECTS;
  if (raw === undefined) return Object.keys(projects);
  const names = raw.split(',');
  for (const name of names) {
    if (projects[name] === undefined)
      throw new Error(`WFD_E2E_PROJECTS 中的 project 不在这份配置中：${name}`);
  }
  return names;
}

// 只启动这一组的 project 用到的服务
export function webServersFor(projects: Record<string, Service[]>): WebServer[] {
  const needed = new Set(selectedNames(projects).flatMap((name) => projects[name] ?? []));
  return [...needed].map((service) => services[service]);
}

// 每组的结果与报告各在自己的目录中，后一组运行时不清掉前一组的
export const e2eGroupName = process.env.WFD_E2E_GROUP ?? 'all';
