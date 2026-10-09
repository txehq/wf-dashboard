import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import { sessions } from '../../src/db/schema.js';
import { watchSession } from '../../src/ingest/watch.js';
import { openTestDb } from '../stages/db.js';

// runner 在 claude 启动前开始监听 jsonl；目录由 runner 预先建好，文件出现后由 add 事件导入
const sessionId = '40f6915a-cd31-4312-866c-dcb377515c42';
const fixture = path.join(import.meta.dirname, '../fixtures/runs', `${sessionId}.jsonl`);
const work = path.join(config.repoRoot, '.work', 'test-watch', randomUUID());
const { db, close } = openTestDb();

afterAll(() => {
  close();
  fs.rmSync(work, { recursive: true, force: true });
});

async function waitSession(id: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (db.select().from(sessions).where(eq(sessions.id, id)).get()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

describe('watchSession 用于实时运行', () => {
  test('目录先建好、文件之后才出现：出现后导入', async () => {
    const dir = path.join(work, 'projects', 'r-20261009-watch1');
    fs.mkdirSync(dir, { recursive: true });
    const watcher = await watchSession(db, path.join(dir, `${sessionId}.jsonl`));
    fs.copyFileSync(fixture, path.join(dir, `${sessionId}.jsonl`));
    // 并行跑全部测试时文件事件与导入都会变慢，10 秒曾经不够
    expect(await waitSession(sessionId, 30_000)).toBe(true);
    await watcher.close();
  }, 40_000);
});
