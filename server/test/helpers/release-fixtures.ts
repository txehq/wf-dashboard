import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { z } from 'zod';
import type { ReleaseRead } from '../../src/variants/release.js';

// 录下的真实 gh release view 输出（scripts/record-release-fixtures.ts 录制）
const root = fileURLToPath(new URL('../fixtures/gh/release/', import.meta.url));

const Recorded = z.object({
  args: z.array(z.string()),
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
});

export type ReleaseFixture = 'latest' | 'older' | 'missing-repo';

export function recordedRelease(name: ReleaseFixture): ReleaseRead {
  const { args, ...result } = Recorded.parse(
    JSON.parse(fs.readFileSync(path.join(root, `${name}.json`), 'utf8')),
  );
  return { args, result };
}

const git = async (args: string[]) => (await execa('git', args)).stdout.trim();

// txe-workflow 的两份本地副本（Contracts 29.1 的测试）：origin 是 bare 仓库，tags 中给出的 tag 都指向 commit；
// work 从 origin clone、不带 tag，作为 txeWorkflowDir。--shared 只读取 source 的对象，不改 source
export async function releaseRepos(
  source: string,
  dir: string,
  tags: { tag: string; commit: string }[],
): Promise<{ origin: string; work: string }> {
  const origin = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');
  await git(['clone', '--quiet', '--bare', '--shared', '--no-tags', source, origin]);
  for (const { tag, commit } of tags) await git(['-C', origin, 'tag', tag, commit]);
  await git(['clone', '--quiet', '--shared', '--no-tags', '--no-checkout', origin, work]);
  return { origin, work };
}
