import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import { artifacts, batches, requests, runs, variants } from '../../src/db/schema.js';
import { ingestFile } from '../../src/ingest/ingest.js';
import { frictionCalls, recordFriction } from '../../src/runs/friction.js';
import type { RequestRow } from '../../src/stages/rows.js';
import { syncTasks } from '../../src/tasks/loader.js';
import { openTestDb } from '../stages/db.js';

// ic run r-20261009-c85gfr 的真实 session：/report-friction 在 txehq/txe-workflow 提了 issue #80
const sessionId = '40f6915a-cd31-4312-866c-dcb377515c42';
const fixture = path.join(import.meta.dirname, '../fixtures/runs', `${sessionId}.jsonl`);
const work = path.join(config.repoRoot, '.work', 'test-friction', randomUUID());
fs.mkdirSync(work, { recursive: true });
const jsonl = path.join(work, `${sessionId}.jsonl`);
fs.copyFileSync(fixture, jsonl);

const { db, close } = openTestDb();
syncTasks(db, config.tasksDir);
const variantId = randomUUID();
const runId = 'r-20261009-c85gfr';
db.insert(variants)
  .values({
    id: variantId,
    name: `friction-${variantId.slice(0, 8)}`,
    baseCommit: '0'.repeat(40),
    skillsHash: 'a'.repeat(64),
    version: '0.0.0-eval.aaaaaaaa',
    model: 'opus',
    effort: 'high',
  })
  .run();
db.insert(batches).values({ id: 'b-20261009-fricti', repeats: 1 }).run();
db.insert(runs)
  .values({
    id: runId,
    batchId: 'b-20261009-fricti',
    taskId: 'ic-money-format',
    variantId,
    repeatIndex: 0,
    status: 'failed',
    sessionId,
    workspacePath: path.join(work, 'workspace'),
  })
  .run();
ingestFile(db, jsonl);

afterAll(() => {
  close();
  fs.rmSync(work, { recursive: true, force: true });
});

const ISSUE_80 = 'https://github.com/txehq/txe-workflow/issues/80';

describe('friction 报告（Contracts 7.10）', () => {
  test('真实 session：只识别成功的 gh issue create，不算 gh issue list', () => {
    const rows = db.select().from(requests).where(eq(requests.sessionId, sessionId)).all();
    const ghIssue = rows.flatMap((r) =>
      r.toolCalls.filter((c) => JSON.stringify(c.input).includes('gh issue')),
    );
    expect(ghIssue.length).toBeGreaterThan(1);
    expect(frictionCalls(rows)).toEqual([
      {
        url: ISSUE_80,
        issueNumber: 80,
        action: 'create',
        toolCallId: 'toolu_01DgokUU187jAKTZ3wgszr47',
      },
    ]);
  });

  test('写入 artifacts：location 为 URL，标题从 GitHub 读取；重复识别不重复写入', async () => {
    await recordFriction(db, runId, sessionId);
    await recordFriction(db, runId, sessionId);
    const rows = db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.runId, runId), eq(artifacts.kind, 'friction')))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.location).toBe(ISSUE_80);
    expect(rows[0]?.snapshot).toMatch(/^\[friction\] \/readiness/);
  }, 60_000);

  test('评论、-R 写法与失败的调用', () => {
    const row = (command: string, result: string, isError = false) =>
      ({
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
      }) as unknown as RequestRow;
    const calls = frictionCalls([
      row(
        'cd x && gh issue comment 80 -R txehq/txe-workflow --body-file b.md',
        `${ISSUE_80}#issuecomment-123`,
      ),
      row(
        'gh issue create --repo txehq/other --title t',
        'https://github.com/txehq/other/issues/1',
      ),
      row('gh issue create --repo txehq/txe-workflow --title t', 'HTTP 422', true),
    ]);
    expect(calls).toEqual([
      expect.objectContaining({
        url: `${ISSUE_80}#issuecomment-123`,
        issueNumber: 80,
        action: 'comment',
      }),
    ]);
  });

  // shell-quote 把换行当空白：多行命令被并成一段，第二行的 gh 不在段首；heredoc 正文被当成参数。
  // 改用 tree-sitter-bash 的 commandsOf 之后按真实的命令结构识别
  test('多行命令与 heredoc：第二行的 gh 被识别，heredoc 正文中的 gh 不算', () => {
    const row = (id: string, command: string, result: string) =>
      ({
        seq: 0,
        toolCalls: [
          {
            id,
            name: 'Bash',
            input: { command },
            result,
            resultChars: result.length,
            isError: false,
            spillPath: null,
            subagentId: null,
          },
        ],
      }) as unknown as RequestRow;
    const calls = frictionCalls([
      row(
        'multi',
        'cd /x\ngh issue create --repo txehq/txe-workflow --title t --body-file b.md',
        ISSUE_80,
      ),
      row(
        'heredoc',
        "cat > b.md <<'EOF'\ngh issue create --repo txehq/txe-workflow --title t\nEOF\necho done",
        ISSUE_80,
      ),
    ]);
    expect(calls.map((c) => [c.toolCallId, c.action])).toEqual([['multi', 'create']]);
  });
});
