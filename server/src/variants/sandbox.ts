import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';

// sandbox-exec 的 SBPL 字符串字面量
const literal = (value: string) => JSON.stringify(value);

// wf 命令的 profile：真实 home 下只允许写 variant 目录，越界写入的进程被 SIGKILL
export function wfSandboxProfile(variantDir: string): string {
  return (
    '(version 1)(allow default)' +
    `(deny file-write* (subpath ${literal(os.homedir())}) (with send-signal SIGKILL))` +
    `(allow file-write* (subpath ${literal(variantDir)}))`
  );
}

export interface SandboxRoots {
  // dashboard 仓库（源代码、tasks/ 中的隐藏测试与 rubric、.spikes/、.work/）
  repoRoot: string;
  // 数据目录（db.sqlite、各 run 与各 variant）；WFD_DATA_DIR 指向仓库外时同样整体禁止读
  dataDir: string;
  runsDir: string;
  variantsDir: string;
  // <vault>/Project Magi Eval/Features
  featuresDir: string;
  home: string;
}

const defaultRoots = (): SandboxRoots => ({
  repoRoot: config.repoRoot,
  dataDir: config.dataDir,
  runsDir: config.runsDir,
  variantsDir: config.variantsDir,
  featuresDir: path.join(config.vaultDir, `Project ${config.evalProduct}`, 'Features'),
  home: os.homedir(),
});

// home 下工具运行需要写的缓存与状态目录（npm、Playwright 浏览器、gh、mcp-remote 的登录、ctx）
const homeCaches = [
  '.npm',
  '.cache',
  '.config',
  '.mcp-auth',
  '.ctx',
  '.local/share',
  '.local/state',
  'Library/Caches',
  'Library/pnpm',
];

// 真实的 Claude 配置、wf 状态、Codex 配置与 ~/.local/bin：越界写入的进程被 SIGKILL
const protectedDirs = [
  '.claude',
  'Library/Application Support/wf',
  'Library/Caches/wf',
  '.codex',
  '.local/bin',
];

// 设计与分析优化的 Claude Code 会话的 profile（Contracts 22.2）：写——home、dashboard 仓库与数据目录中只允许工作目录（其中有会话自己的
// claude-config/ 与 .claude/skills/）、npm 缓存与 mcp-remote 的登录（~/.mcp-auth，刷新 token 时写回，Contracts 28.1）；
// 读——dashboard 仓库与数据目录中只放行工作目录与 files
// （claude 读的 hooks 设置文件、在仓库中时的 claude 程序本身）。网络照常
export function sessionSandboxProfile(
  workDir: string,
  files: string[],
  roots: Pick<SandboxRoots, 'repoRoot' | 'dataDir' | 'home'> = defaultRoots(),
): string {
  const subpath = (dir: string) => `(subpath ${literal(dir)})`;
  return [
    '(version 1)(allow default)',
    `(deny file-write* ${[roots.home, roots.repoRoot, roots.dataDir].map(subpath).join(' ')})`,
    `(allow file-write* ${subpath(workDir)} ${subpath(path.join(roots.home, '.npm'))} ${subpath(path.join(roots.home, '.mcp-auth'))})`,
    ...protectedDirs.map(
      (dir) =>
        `(deny file-write* ${subpath(path.join(roots.home, dir))} (with send-signal SIGKILL))`,
    ),
    `(deny file-write* (literal ${literal(path.join(roots.home, '.claude.json'))}) (with send-signal SIGKILL))`,
    `(deny file-read-data ${subpath(roots.repoRoot)} ${subpath(roots.dataDir)})`,
    `(allow file-read-data ${subpath(workDir)}${files.map((f) => ` (literal ${literal(f)})`).join('')})`,
  ].join('');
}

// claude 进程的 profile（Contracts 7.3），claude、hook、MCP 与 tool 子进程都继承：
// 写——home、dashboard 仓库、数据目录与 vault 的 Project <product> 目录中只允许本 run 的目录、本 variant 的目录、
// 本 run 的 feature 目录与工具缓存（它们不在 home 下时同样禁止写）；
// 读——整个 dashboard 仓库与数据目录都不能读，只放行本 run 的目录与本 variant 的目录（其中再禁止其他 run 的 session），
// 也不能读其他 run 的 feature 目录。
// 本地仓库模式（Contracts 7.2）下 localRepo 是本 run 的 bare 仓库：可读写，同目录下其他 run 的仓库不能读。
// 读限制只拦 file-read-data（文件内容与目录列表），路径查找与 stat 照常，父目录不影响访问自己的目录。
// SBPL 中后出现的规则优先
export function claudeSandboxProfile(
  runId: string,
  variantId: string,
  roots: SandboxRoots = defaultRoots(),
  localRepo: string | null = null,
): string {
  const variantDir = path.join(roots.variantsDir, variantId);
  const projectsDir = path.join(variantDir, 'home', 'claude', 'projects');
  const subpath = (dir: string) => `(subpath ${literal(dir)})`;
  return runProfile(runId, roots, localRepo, {
    write: [variantDir],
    read: [
      `(allow file-read-data ${subpath(variantDir)})`,
      `(deny file-read-data ${subpath(projectsDir)})`,
      `(allow file-read-data ${subpath(path.join(projectsDir, runId))})`,
    ],
  });
}

// isolated 环境中用本机配置的交互进程（Contracts 29.2）：与 claudeSandboxProfile 相同，只是 variant 目录换成
// claudeHome 下的 .claude 与 .claude.json（Claude Code 读凭据、写 session 与状态），以及用户的 hook 与 wf 装的 skill
// 调用的 wf 所写的状态目录，这些都可读写：用户自己的配置照常工作
export function localClaudeSandboxProfile(
  runId: string,
  claudeHome: string,
  roots: SandboxRoots = defaultRoots(),
  localRepo: string | null = null,
): string {
  const subpath = (dir: string) => `(subpath ${literal(dir)})`;
  const owned = [
    path.join(claudeHome, '.claude'),
    ...wfStateDirs.map((d) => path.join(claudeHome, d)),
  ];
  const state = path.join(claudeHome, '.claude.json');
  // .claude.json 先写到同目录的临时文件再改名，旁边还有它的备份
  const stateFiles = `(literal ${literal(state)}) (regex #"^${escapeRegex(state)}\\.")`;
  return runProfile(runId, roots, localRepo, {
    write: [],
    read: [`(allow file-read-data file-write* ${owned.map(subpath).join(' ')} ${stateFiles})`],
  });
}

// wf 的状态目录（protectedDirs 中的两个）
const wfStateDirs = ['Library/Application Support/wf', 'Library/Caches/wf'];

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 一个 run（或交互项）的 claude 进程的 profile；config 是它的 Claude 配置额外可写的目录与最后追加的读写规则
function runProfile(
  runId: string,
  roots: SandboxRoots,
  localRepo: string | null,
  config: { write: string[]; read: string[] },
): string {
  const runDir = path.join(roots.runsDir, runId);
  const featureDir = path.join(roots.featuresDir, runId);
  const subpath = (dir: string) => `(subpath ${literal(dir)})`;
  return [
    '(version 1)(allow default)',
    `(deny file-write* ${[roots.home, roots.repoRoot, roots.dataDir, path.dirname(roots.featuresDir)].map(subpath).join(' ')})`,
    `(allow file-write* ${[runDir, ...config.write, featureDir, ...homeCaches.map((d) => path.join(roots.home, d))].map(subpath).join(' ')})`,
    ...protectedDirs.map(
      (dir) =>
        `(deny file-write* ${subpath(path.join(roots.home, dir))} (with send-signal SIGKILL))`,
    ),
    `(deny file-write* (literal ${literal(path.join(roots.home, '.claude.json'))}) (with send-signal SIGKILL))`,
    `(deny file-read-data ${[roots.repoRoot, roots.dataDir, roots.runsDir, roots.variantsDir, roots.featuresDir].map(subpath).join(' ')})`,
    `(allow file-read-data ${subpath(runDir)} ${subpath(featureDir)})`,
    ...config.read,
    ...(localRepo === null
      ? []
      : [
          `(deny file-read-data ${subpath(path.dirname(localRepo))})`,
          `(allow file-read-data file-write* ${subpath(localRepo)})`,
        ]),
  ].join('');
}
