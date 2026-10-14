import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { githubCheck } from '../src/environment.js';

// W57：环境检查中 gh 一项的修复方法按 gh 的实际错误给出。PATH 最前面换成按参数回放录制文件的 gh
// （test/fixtures/gh-errors/bin/gh），回放的是 scripts/record-gh-error-fixtures.ts 录下的真实 gh 输出；
// TLS 握手超时是 2026-10-13 用户实例环境检查中的那一次
const dir = path.join(import.meta.dirname, 'fixtures/gh-errors');
const Fixture = z.object({
  kind: z.enum(['auth', 'network', 'other']),
  commands: z.array(
    z.object({ args: z.array(z.string()), exitCode: z.number(), output: z.string() }),
  ),
});
const fixtures = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => ({
    name: f.replace(/\.json$/, ''),
    file: path.join(dir, f),
    ...Fixture.parse(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))),
  }));
const ofKind = (kind: string) => fixtures.filter((f) => f.kind === kind);

const originalPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.WFD_GH_REPLAY;
});

// 用录下的一种情形运行环境检查中的 gh 一项
async function check(file: string) {
  process.env.PATH = `${path.join(dir, 'bin')}:${originalPath ?? ''}`;
  process.env.WFD_GH_REPLAY = file;
  return githubCheck();
}

// 决定结果的那条命令（最后一条失败的命令）的输出；detail 去掉首尾空白
const decisive = (f: (typeof fixtures)[number]) =>
  f.commands.findLast((c) => c.exitCode !== 0)?.output.trim();

test('录下的错误覆盖三种类型，其中有 TLS 握手超时', () => {
  expect(new Set(fixtures.map((f) => f.kind))).toEqual(new Set(['auth', 'network', 'other']));
  expect(ofKind('network').map((f) => f.name)).toContain('tls-handshake-timeout');
});

test('未登录或 token 失效：提示 gh auth login', async () => {
  for (const f of ofKind('auth')) {
    const result = await check(f.file);
    expect(result.ok, f.name).toBe(false);
    expect(result.fix, f.name).toBe(
      'gh auth login --hostname github.com --git-protocol https --web',
    );
  }
});

test('网络错误（TLS 握手超时、连接被拒、DNS 失败）：说明是网络问题，提示检查网络或代理后重新检查，不提示登录', async () => {
  for (const f of ofKind('network')) {
    const result = await check(f.file);
    expect(result.ok, f.name).toBe(false);
    expect(result.fix, f.name).toBe('网络问题，连不上 GitHub：检查网络或代理后点「重新检查」');
    expect(result.detail, f.name).toContain(decisive(f));
  }
});

test('其他错误：detail 中原样是 gh 的输出', async () => {
  for (const f of ofKind('other')) {
    const result = await check(f.file);
    expect(result.ok, f.name).toBe(false);
    expect(result.detail, f.name).toContain(decisive(f));
    expect(result.fix, f.name).toBe('按上面 gh 的输出处理后点「重新检查」');
  }
});
