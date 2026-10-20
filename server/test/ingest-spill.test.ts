import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, expect, test } from 'vitest';
import { config } from '../src/config.js';
import { type Db, openDatabase } from '../src/db/index.js';
import { requests } from '../src/db/schema.js';
import { ingestFile } from '../src/ingest/ingest.js';

// 溢出输出的判定（W63），fixtures/spill/ 下是真实 session 中的行（/Users/<用户> 已换掉）：
// - real：Claude Code 真正写出的溢出，路径在这个 session 自己的 <sessionId>/tool-results/ 下，旁边有溢出文件；
// - quoted：分析 session 中用 jq 读另一个 session 的导出记录，Bash 的输出以那个 session 的 <persisted-output> 开头
//   （一条被 jq 截在 150 字处，路径只剩到 variants/80ef1f07；一条完整，指向别的 session 的 tool-results/），不是溢出
const fixtures = path.join(import.meta.dirname, 'fixtures', 'spill');
const workDir = path.join(config.repoRoot, '.work', 'test-ingest-spill', randomUUID());
const opened: Db[] = [];

afterAll(() => {
  for (const db of opened) db.$client.close();
  rmSync(workDir, { recursive: true, force: true });
});

// 复制到 .work/ 下导入；返回这个 session 的全部 tool 调用
function ingestCopy(name: string, sessionId: string, keepSpills = true) {
  const dir = path.join(workDir, randomUUID());
  cpSync(path.join(fixtures, name), dir, { recursive: true });
  if (!keepSpills) rmSync(path.join(dir, sessionId), { recursive: true, force: true });
  const db = openDatabase(path.join(dir, 'db.sqlite'), config.migrationsDir);
  opened.push(db);
  const file = path.join(dir, `${sessionId}.jsonl`);
  ingestFile(db, file);
  const calls = db
    .select()
    .from(requests)
    .where(eq(requests.sessionId, sessionId))
    .all()
    .flatMap((r) => r.toolCalls);
  return { dir, calls };
}

test('Claude Code 写出的溢出：spillPath 指向本地 <sessionId>/tool-results/ 下的文件', () => {
  const id = 'f3488cd1-1371-4b5f-96e9-bb71b156bd03';
  const { dir, calls } = ingestCopy('real', id);
  const spilled = calls.filter((c) => c.spillPath !== null);
  expect(spilled).toHaveLength(1);
  expect(spilled[0]?.result?.startsWith('<persisted-output>')).toBe(true);
  expect(spilled[0]?.spillPath).toBe(path.join(dir, id, 'tool-results', 'bobyx4l87.txt'));
  expect(existsSync(spilled[0]?.spillPath ?? '')).toBe(true);
});

test('真正的溢出缺了文件时照常以原文报错', () => {
  const id = 'f3488cd1-1371-4b5f-96e9-bb71b156bd03';
  expect(() => ingestCopy('real', id, false)).toThrow(/溢出文件不存在：.*bobyx4l87\.txt/);
});

test('工具输出中引用的另一个 session 的溢出提示不是溢出：照常导入，结果保留原文', () => {
  const id = '70f4ffbe-67e0-43a9-b99e-7e426beb0f9b';
  const { calls } = ingestCopy('quoted', id);
  const quoted = calls.filter((c) => c.result?.startsWith('<persisted-output>') === true);
  expect(quoted).toHaveLength(2);
  for (const c of quoted) expect(c.spillPath).toBeNull();
  // 被 jq 截断的那条：路径只到 variants/80ef1f07，之前取到的文件名就是 80ef1f07
  expect(quoted.some((c) => c.result?.includes('data-ic/variants/80ef1f07\n') === true)).toBe(true);
});
