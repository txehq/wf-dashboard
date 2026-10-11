import os from 'node:os';
import path from 'node:path';

// sandbox-exec 的 SBPL 字符串字面量
const literal = (value: string) => JSON.stringify(value);
const subpath = (dir: string) => `(subpath ${literal(dir)})`;

export interface AnalysisSandboxRoots {
  // data/analyses/<id>：其中 input/ 只读、output/ 可写
  analysisDir: string;
  // 引擎自己的配置目录（CLAUDE_CONFIG_DIR 或 CODEX_HOME），引擎要写会话与缓存
  engineHome: string;
  // dashboard 仓库与数据目录：整体不能读写，只放行分析目录
  repoRoot: string;
  dataDir: string;
  home?: string;
}

// 分析引擎进程的 profile（Contracts 15.2）：只读 input/、只写 output/。
// 读限制只拦 file-read-data（内容与目录列表）；用户的 ~/.claude 与 ~/.codex（其他 session、凭据）也不能读。
// SBPL 中后出现的规则优先
export function analysisSandboxProfile(roots: AnalysisSandboxRoots): string {
  const home = roots.home ?? os.homedir();
  const output = path.join(roots.analysisDir, 'output');
  return [
    '(version 1)(allow default)',
    `(deny file-write* ${subpath(home)} ${subpath(roots.repoRoot)} ${subpath(roots.dataDir)})`,
    `(allow file-write* ${[output, roots.engineHome, path.join(home, '.cache'), path.join(home, 'Library/Caches')].map(subpath).join(' ')})`,
    `(deny file-read-data ${[roots.repoRoot, roots.dataDir, path.join(home, '.claude'), path.join(home, '.codex')].map(subpath).join(' ')} (literal ${literal(path.join(home, '.claude.json'))}))`,
    `(allow file-read-data ${subpath(roots.analysisDir)} ${subpath(roots.engineHome)})`,
    `(deny file-write* ${subpath(path.join(roots.analysisDir, 'input'))})`,
  ].join('');
}
