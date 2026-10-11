import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import { sessions } from '../../src/db/schema.js';
import { watchSession } from '../../src/ingest/watch.js';
import { openTestDb } from '../stages/db.js';

// runner 在 claude 启动前开始监听 jsonl；文件出现后由下一次增量导入读入
const sessionId = '40f6915a-cd31-4312-866c-dcb377515c42';
const fixture = path.join(import.meta.dirname, '../fixtures/runs', `${sessionId}.jsonl`);
const work = path.join(config.repoRoot, '.work', 'test-watch', randomUUID());
const { db, close } = openTestDb();

afterAll(() => {
  close();
  fs.rmSync(work, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return check();
}

const sessionRow = (id: string) => db.select().from(sessions).where(eq(sessions.id, id)).get();

// fixture 换成新的 session id，写到 .work 下；返回内容
function copyFixture(id: string): string {
  const source = fs.readFileSync(fixture, 'utf8').replaceAll(sessionId, id);
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, `${id}.source.jsonl`), source);
  return source;
}

describe('watchSession 用于实时运行', () => {
  test('目录先建好、文件之后才出现：出现后导入', async () => {
    const id = randomUUID();
    const source = copyFixture(id);
    const dir = path.join(work, 'projects', 'r-20261009-watch1');
    fs.mkdirSync(dir, { recursive: true });
    const errors: Error[] = [];
    const watcher = watchSession(db, path.join(dir, `${id}.jsonl`), (e) => errors.push(e));
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), source);
    expect(await waitFor(() => sessionRow(id) !== undefined || errors.length > 0, 10_000)).toBe(
      true,
    );
    expect(errors).toEqual([]);
    await watcher.close();
  }, 20_000);

  // 与真实运行相同：开始监听时 projects/<runId>/ 还不存在，由 claude 进程建目录并分几次写入
  test('目录还不存在、由另一个进程建目录并追加写入：全部导入', async () => {
    const id = randomUUID();
    const source = copyFixture(id);
    const dir = path.join(work, 'projects', 'r-20261009-watch2');
    const file = path.join(dir, `${id}.jsonl`);
    const errors: Error[] = [];
    const watcher = watchSession(db, file, (e) => errors.push(e));
    const writer = spawn('bash', [
      '-c',
      'mkdir -p "$1" && head -n 5 "$2" > "$3" && sleep 1 && tail -n +6 "$2" >> "$3"',
      'writer',
      dir,
      path.join(work, `${id}.source.jsonl`),
      file,
    ]);
    const code = await new Promise<number | null>((resolve) => writer.on('exit', resolve));
    expect(code).toBe(0);
    const done = () => sessionRow(id)?.parseOffset === Buffer.byteLength(source);
    expect(await waitFor(() => done() || errors.length > 0, 10_000)).toBe(true);
    expect(errors).toEqual([]);
    await watcher.close();
  }, 20_000);

  // 另一个进程在别的目录中不停地建、写、删文件（e2e 构建、其他 run 写 jsonl 时的情形）：
  // macOS 的 FSEvents 在这种负载下会丢弃事件，导入不能依赖文件系统事件
  test('大量文件写入的同时出现的 jsonl：照常导入', async () => {
    const id = randomUUID();
    const source = copyFixture(id);
    const dir = path.join(work, 'projects', 'r-20261009-watch4');
    const flood = path.join(work, 'flood');
    fs.mkdirSync(flood, { recursive: true });
    const writers = Array.from({ length: 8 }, (_, k) =>
      spawn('bash', [
        '-c',
        'mkdir -p "$1" && while true; do for j in $(seq 1 200); do echo x > "$1/$j"; done; rm -f "$1"/*; done',
        'flood',
        path.join(flood, String(k)),
      ]),
    );
    const errors: Error[] = [];
    const file = path.join(dir, `${id}.jsonl`);
    const watcher = watchSession(db, file, (e) => errors.push(e));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, source);
    const done = () => sessionRow(id)?.parseOffset === Buffer.byteLength(source);
    const imported = await waitFor(() => done() || errors.length > 0, 10_000);
    for (const w of writers) w.kill();
    expect(imported).toBe(true);
    expect(errors).toEqual([]);
    await watcher.close();
  }, 20_000);

  // W15 H1：事件回调中的导入错误以前成为 uncaught exception，整个服务退出；现在交给 onError，之后不再导入
  test('增量导入出错时交给 onError，进程不退出，之后的写入不再导入', async () => {
    const id = randomUUID();
    const source = copyFixture(id);
    const dir = path.join(work, 'projects', 'r-20261009-watch3');
    const file = path.join(dir, `${id}.jsonl`);
    fs.mkdirSync(dir, { recursive: true });
    const head = source.split('\n').slice(0, 12).join('\n');
    fs.writeFileSync(file, `${head}\n`);
    const errors: Error[] = [];
    const watcher = watchSession(db, file, (e) => errors.push(e));
    const imported = sessionRow(id)?.parseOffset;
    expect(imported).toBe(Buffer.byteLength(`${head}\n`));
    // 一条找不到 tool_use 的 tool_result（W15 的 watch-crash 复现）
    const bad = {
      type: 'user',
      uuid: randomUUID(),
      parentUuid: null,
      sessionId: id,
      timestamp: '2026-10-09T15:08:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_missing', content: 'x' }],
      },
    };
    fs.appendFileSync(file, `${JSON.stringify(bad)}\n`);
    expect(await waitFor(() => errors.length > 0, 10_000)).toBe(true);
    expect(errors[0]?.message).toContain('tool_result toolu_missing 没有对应的 tool_use');
    // 出错的那次导入整体回滚；之后追加的内容不再导入，错误只报告一次
    fs.appendFileSync(file, source.split('\n').slice(12).join('\n'));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(sessionRow(id)?.parseOffset).toBe(imported);
    expect(errors).toHaveLength(1);
    await watcher.close();
  }, 20_000);
});
