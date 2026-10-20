import fs from 'node:fs';
import path from 'node:path';
import { format, resolveConfig } from 'prettier';
import { config } from '../src/config.js';
import { ghResult } from '../src/external/github.js';
import { RELEASE_REPO, releaseArgs } from '../src/variants/release.js';

// 录下检查 txe-workflow 最新版时 gh 的真实输出（Contracts 29.1），存为 test/fixtures/gh/release/<名字>.json
// （args、exitCode、stdout、stderr、recordedAt）。只读取 GitHub。
// 运行：pnpm --filter @wf-dashboard/server record:release-fixtures
const dir = path.join(config.repoRoot, 'server/test/fixtures/gh/release');

const sources: { name: string; args: string[] }[] = [
  // 标为 Latest 的 release
  { name: 'latest', args: releaseArgs(RELEASE_REPO, null) },
  // 更早的一个 release：测试中先读到它，再读到 latest，即"出了新的 release"
  { name: 'older', args: releaseArgs(RELEASE_REPO, 'v2.2.2') },
  // 仓库不存在：gh 以非零退出码与 stderr 失败
  { name: 'missing-repo', args: releaseArgs('txehq/wfd-no-such-repo-w91', null) },
];

fs.mkdirSync(dir, { recursive: true });
for (const { name, args } of sources) {
  const result = await ghResult(args);
  const file = path.join(dir, `${name}.json`);
  const options = await resolveConfig(file);
  const text = JSON.stringify({ args, ...result, recordedAt: new Date().toISOString() });
  fs.writeFileSync(file, await format(text, { ...options, filepath: file }));
  console.log(`${file}：exit ${String(result.exitCode)}`);
}
