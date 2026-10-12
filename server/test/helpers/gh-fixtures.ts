import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { expect } from 'vitest';
import { z } from 'zod';
import { type GhResult, prArgs } from '../../src/external/github.js';

// 录下的真实 gh 输出（scripts/record-gh-fixtures.ts 录制）：每条记录的参数必须与当前的 prArgs 相同，
// 命令改了而 fixture 没有重录时以断言失败
const root = fileURLToPath(new URL('../fixtures/gh/', import.meta.url));

const Meta = z.object({ repo: z.string(), pr: z.number().nullable(), recordedAt: z.string() });
const Recorded = z.object({
  args: z.array(z.string()),
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
});

type Key = keyof typeof prArgs;

export function recordedPr(name: string) {
  const dir = path.join(root, name);
  const meta = Meta.parse(JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')));
  const result = (key: Key): GhResult => {
    const { args, ...rest } = Recorded.parse(
      JSON.parse(fs.readFileSync(path.join(dir, `${key}.json`), 'utf8')),
    );
    expect(args).toEqual(key === 'list' ? prArgs.list(meta.repo) : prArgs[key](meta.repo, pr()));
    return rest;
  };
  const pr = () => {
    if (meta.pr === null) throw new Error(`fixture ${name} 没有 PR`);
    return meta.pr;
  };
  const stdout = (key: Key) => {
    const r = result(key);
    if (r.exitCode !== 0)
      throw new Error(`fixture ${name}/${key} 的退出码是 ${String(r.exitCode)}`);
    return r.stdout;
  };
  return {
    repo: meta.repo,
    pr,
    result,
    stdout,
    // 录制时 PR head 的完整历史（只有 grade-pr 有）：clone 到 dest 并停在 head
    async checkout(head: string, dest: string): Promise<{ head: string }> {
      await execa('git', ['clone', '--quiet', path.join(dir, 'pr-head.bundle'), dest]);
      await execa('git', ['-C', dest, 'checkout', '--quiet', '--detach', head]);
      return { head: (await execa('git', ['-C', dest, 'rev-parse', 'HEAD'])).stdout };
    },
  };
}
