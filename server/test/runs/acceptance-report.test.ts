import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import { artifacts, batches, requests, runs, variants } from '../../src/db/schema.js';
import { ingestFile } from '../../src/ingest/ingest.js';
import { acceptanceReports, recordAcceptanceReport } from '../../src/runs/acceptance-report.js';
import type { RequestRow } from '../../src/stages/rows.js';
import { syncTasks } from '../../src/tasks/loader.js';
import { openTestDb } from '../stages/db.js';

// ic run r-20261010-t5x8pr（ic-unit-converter）的真实 session：/acceptance 先逐张发布截图（img），
// 再发布验收报告页面 3lpww2so；fixture 用 gzip 压缩
const sessionId = 'f40729f0-3944-40a8-b106-52d6a9b602d6';
const fixture = path.join(import.meta.dirname, '../fixtures/runs', `${sessionId}.jsonl.gz`);
const work = path.join(config.repoRoot, '.work', 'test-acceptance', randomUUID());
fs.mkdirSync(work, { recursive: true });
const jsonl = path.join(work, `${sessionId}.jsonl`);
fs.writeFileSync(jsonl, gunzipSync(fs.readFileSync(fixture)));

const { db, close } = openTestDb();
syncTasks(db, config.tasksDir);
const variantId = randomUUID();
const runId = 'r-20261010-t5x8pr';
db.insert(variants)
  .values({
    id: variantId,
    name: `acceptance-${variantId.slice(0, 8)}`,
    baseCommit: '0'.repeat(40),
    skillsHash: 'a'.repeat(64),
    version: '0.0.0-eval.aaaaaaaa',
    model: 'opus',
    effort: 'high',
  })
  .run();
db.insert(batches).values({ id: 'b-20261010-accept', repeats: 1 }).run();
db.insert(runs)
  .values({
    id: runId,
    batchId: 'b-20261010-accept',
    taskId: 'ic-unit-converter',
    variantId,
    repeatIndex: 0,
    status: 'succeeded',
    sessionId,
    workspacePath: path.join(work, 'workspace'),
  })
  .run();
ingestFile(db, jsonl);

afterAll(() => {
  close();
  fs.rmSync(work, { recursive: true, force: true });
});

const REPORT = 'https://engapp.dev/artifacts/page/3lpww2so';

function bash(command: string, result: string, isError = false): RequestRow {
  return {
    seq: 0,
    toolCalls: [
      {
        id: `t-${String(command.length)}`,
        name: 'Bash',
        input: { command },
        result,
        resultChars: result.length,
        isError,
        spillPath: null,
        subagentId: null,
      },
    ],
  } as unknown as RequestRow;
}

describe('验收报告（Contracts 7.2）', () => {
  test('真实 session：截图的 img 发布与 --help 不算，只识别标题含 acceptance 的页面', async () => {
    const rows = db.select().from(requests).where(eq(requests.sessionId, sessionId)).all();
    const publishes = rows.flatMap((r) =>
      r.toolCalls.filter((c) => JSON.stringify(c.input).includes('wf publish-artifact')),
    );
    expect(publishes.length).toBeGreaterThan(2);
    const reports = await acceptanceReports(rows);
    expect(reports.map((r) => r.url)).toContain(REPORT);
    expect(reports.every((r) => r.url.startsWith('https://engapp.dev/artifacts/page/'))).toBe(true);
    expect(reports.find((r) => r.url === REPORT)?.title).toBe('TXE-3875 单位换算页面 - acceptance');
  });

  test('写入 artifacts：每个 run 一条，location 为最后一次发布的页面', async () => {
    await recordAcceptanceReport(db, runId, sessionId);
    await recordAcceptanceReport(db, runId, sessionId);
    const rows = db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.runId, runId), eq(artifacts.kind, 'acceptance')))
      .all();
    expect(rows).toHaveLength(1);
    const all = await acceptanceReports(
      db.select().from(requests).where(eq(requests.sessionId, sessionId)).all(),
    );
    expect(rows[0]?.location).toBe(all.at(-1)?.url);
    expect(JSON.parse(rows[0]?.snapshot ?? 'null')).toMatchObject({ title: all.at(-1)?.title });
  });

  test('env 前缀、--title= 写法、dry-run、失败的调用与其他标题', async () => {
    const page = (id: string) => `https://engapp.dev/artifacts/page/${id}`;
    const reports = await acceptanceReports([
      bash(
        'env -u ALL_PROXY HTTPS_PROXY=http://p wf publish-artifact r.html --title "A - acceptance"',
        page('aaaaaaaa'),
      ),
      bash('wf publish-artifact r.html --title=验收报告 --id bbbbbbbb', page('bbbbbbbb')),
      bash('wf publish-artifact r.html --title "x - acceptance" --dry-run', page('cccccccc')),
      bash('wf publish-artifact r.html --title "y - acceptance"', 'HTTP 403', true),
      bash('wf publish-artifact e.html --title "Explainer"', page('dddddddd')),
    ]);
    expect(reports.map((r) => [r.url, r.title])).toEqual([
      [page('aaaaaaaa'), 'A - acceptance'],
      [page('bbbbbbbb'), '验收报告'],
    ]);
  });
});
