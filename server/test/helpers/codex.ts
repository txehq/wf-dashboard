import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../src/config.js';
import { codexStandIn } from './codex-skills.js';

// createLive 的 codex 依赖：bin 默认是替身命令，认证与模型配置来自 config
export function testCodex(bin = codexStandIn) {
  return {
    bin,
    sources: { authPath: config.codexAuthPath, configPath: config.codexConfigPath },
    sessionTimeoutMs: 30_000,
  };
}

// 真实的 codex（PATH 中跳过 test/setup/basic-bin 里会报错的那个）：codex archive、unarchive、delete 不调用模型，
// 基础档中只对测试自己建的 CODEX_HOME 运行（Contracts 25.3）
export function realCodexBin(): string {
  const blocked = path.resolve(import.meta.dirname, '../setup/basic-bin');
  for (const dir of String(process.env.PATH).split(path.delimiter)) {
    if (path.resolve(dir).startsWith(blocked)) continue;
    const file = path.join(dir, 'codex');
    if (fs.existsSync(file)) return file;
  }
  throw new Error(`PATH 中没有 codex：${String(process.env.PATH)}`);
}
