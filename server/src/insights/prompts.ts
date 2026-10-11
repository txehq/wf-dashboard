import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { AnalysisAspect } from '../db/schema.js';
import { findingsFile } from './validate.js';

// 提示词在 server/src/insights/prompts/（pnpm start 运行 dist 时同样从源码目录读取）；文件头的出处注释不发给引擎
const promptsDir = path.join(config.repoRoot, 'server/src/insights/prompts');

function read(name: string): string {
  return fs
    .readFileSync(path.join(promptsDir, `${name}.md`), 'utf8')
    .replace(/^<!--[\s\S]*?-->\n+/, '');
}

const aspectTitle: Record<AnalysisAspect, string> = {
  process: '流程遵守',
  efficiency: '效率与花费',
  interaction: '和用户的交互',
  quality: '产物质量',
};

export function aspectPrompt(aspect: AnalysisAspect): string {
  return [
    read('common'),
    read(aspect),
    `## 这一步\n\n只分析「${aspectTitle[aspect]}」这一个方面。把发现写入 \`output/${findingsFile(aspect)}\`。`,
  ].join('\n\n');
}

export function synthesisPrompt(): string {
  return read('synthesis');
}
