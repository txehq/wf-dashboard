import path from 'node:path';
import type { SourceDirs } from '../../src/ingest/sources.js';

// 测试中 Sessions 的来源目录：Claude Code 的 projects 目录与 variant 目录由测试给出，本机 Codex 的 CODEX_HOME、
// 草稿目录与分析目录放在测试自己的目录 root 下（不读写用户的 ~/.codex）
export function testSourceDirs(
  root: string,
  dirs: { projectsDir: string; variantsDir: string },
): SourceDirs {
  return {
    ...dirs,
    codexHome: path.join(root, 'codex-home'),
    draftsDir: path.join(root, 'workflow-drafts'),
    analysesDir: path.join(root, 'analyses'),
  };
}
