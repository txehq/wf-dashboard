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

// claude 进程的 profile（Contracts 7.3），claude、hook、MCP 与 tool 子进程都继承：
// 写——home 下只允许本 run 的目录、本 variant 的目录、vault 中本 run 的 feature 目录与工具缓存；
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
  const runDir = path.join(roots.runsDir, runId);
  const variantDir = path.join(roots.variantsDir, variantId);
  const projectsDir = path.join(variantDir, 'home', 'claude', 'projects');
  const featureDir = path.join(roots.featuresDir, runId);
  const subpath = (dir: string) => `(subpath ${literal(dir)})`;
  return [
    '(version 1)(allow default)',
    `(deny file-write* ${subpath(roots.home)})`,
    `(allow file-write* ${[runDir, variantDir, featureDir, ...homeCaches.map((d) => path.join(roots.home, d))].map(subpath).join(' ')})`,
    ...protectedDirs.map(
      (dir) =>
        `(deny file-write* ${subpath(path.join(roots.home, dir))} (with send-signal SIGKILL))`,
    ),
    `(deny file-write* (literal ${literal(path.join(roots.home, '.claude.json'))}) (with send-signal SIGKILL))`,
    `(deny file-read-data ${[roots.repoRoot, roots.dataDir, roots.runsDir, roots.variantsDir, roots.featuresDir].map(subpath).join(' ')})`,
    `(allow file-read-data ${subpath(runDir)} ${subpath(variantDir)} ${subpath(featureDir)})`,
    `(deny file-read-data ${subpath(projectsDir)})`,
    `(allow file-read-data ${subpath(path.join(projectsDir, runId))})`,
    ...(localRepo === null
      ? []
      : [
          `(deny file-read-data ${subpath(path.dirname(localRepo))})`,
          `(allow file-read-data file-write* ${subpath(localRepo)})`,
        ]),
  ].join('');
}
