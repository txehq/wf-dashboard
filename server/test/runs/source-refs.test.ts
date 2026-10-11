import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import { batches, requests, runs, variants } from '../../src/db/schema.js';
import { ingestFile } from '../../src/ingest/ingest.js';
import { scanSourceRefs } from '../../src/runs/source-refs.js';
import { syncTasks } from '../../src/tasks/loader.js';
import { unpackRunFixture } from '../helpers/run-fixture.js';
import { openTestDb } from '../stages/db.js';

// W28 的真实 ic run r-20261011-5vqkvn（task ic-txe-3635，来源工单 TXE-3635、来源仓库 txehq/tokun-cn）：
// agent 经 Linear 读了来源工单与评论，并运行了 gh pr view 638 --repo txehq/tokun-cn
const runId = 'r-20261011-5vqkvn';
const sessionId = '8f501373-c26d-4602-a1c1-95817c272eeb';
// 对照：ic-money-format 的 run r-20261009-27yz3d，没有读来源
const cleanRunId = 'r-20261009-27yz3d';
const cleanSessionId = '70e7a9b6-fdad-44c3-9b65-015ee2a0499c';
const work = path.join(config.repoRoot, '.work', 'test-source-refs', randomUUID());

const { db, close } = openTestDb();
syncTasks(db, path.join(import.meta.dirname, '../fixtures/source-refs/tasks'));
db.insert(variants)
  .values({
    id: 'v-source-refs',
    name: 'source-refs',
    baseCommit: '0'.repeat(40),
    skillsHash: 'a'.repeat(64),
    version: '0.0.0-eval.aaaaaaaa',
    model: 'opus',
    effort: 'high',
  })
  .run();
db.insert(batches).values({ id: 'b-20261011-source', repeats: 1 }).run();
for (const [index, [id, session]] of [
  [runId, sessionId],
  [cleanRunId, cleanSessionId],
].entries()) {
  db.insert(runs)
    .values({
      id: id ?? '',
      batchId: 'b-20261011-source',
      // 两个 run 都记在导入的 task 下：对照 run 的 session 中没有出现 TXE-3635 与 txehq/tokun-cn
      taskId: 'ic-txe-3635',
      variantId: 'v-source-refs',
      repeatIndex: index,
      status: 'succeeded',
      sessionId: session ?? '',
      workspacePath: path.join(work, id ?? '', 'workspace'),
    })
    .run();
  ingestFile(db, unpackRunFixture(id ?? '', session ?? '', path.join(work, id ?? '')));
}

afterAll(() => {
  close();
  fs.rmSync(work, { recursive: true, force: true });
});

function mainSeqOf(toolCallId: string): number {
  const row = db
    .select()
    .from(requests)
    .where(and(eq(requests.sessionId, sessionId), isNull(requests.agentId)))
    .all()
    .find((r) => r.toolCalls.some((c) => c.id === toolCallId));
  if (row === undefined) throw new Error(`主 session 中没有 ${toolCallId}`);
  return row.seq;
}

describe('读取来源的记录（Contracts 第 13 节）：真实 session', () => {
  const refs = scanSourceRefs(db, runId);

  test('Linear get_issue 与 list_comments 读来源工单 TXE-3635：kind ticket，摘录为输入字段', () => {
    const getIssue = 'toolu_bdrk_01QCeHzuTtWmpLi1UFXNwL1g';
    const comments = 'toolu_bdrk_01LXPZQBcTxeL7sAG8hUjyAU';
    expect(refs.filter((r) => [getIssue, comments].includes(r.toolCallId))).toEqual([
      {
        kind: 'ticket',
        requestSeq: mainSeqOf(getIssue),
        toolCallId: getIssue,
        excerpt: 'id: TXE-3635',
      },
      {
        kind: 'ticket',
        requestSeq: mainSeqOf(comments),
        toolCallId: comments,
        excerpt: 'issueId: TXE-3635',
      },
    ]);
  });

  test('gh pr view 638 --repo txehq/tokun-cn：kind pr，同一调用不再记 repo', () => {
    const call = 'toolu_bdrk_01447pzySpo1zxgUJQ9LDxB5';
    const own = refs.filter((r) => r.toolCallId === call);
    expect(own.map((r) => [r.kind, r.requestSeq])).toEqual([['pr', mainSeqOf(call)]]);
    expect(own[0]?.excerpt).toContain(
      'gh pr view 638 --repo txehq/tokun-cn --json state,mergedAt,headRefName,title,mergeCommit',
    );
    expect(own[0]?.excerpt.startsWith('command: ')).toBe(true);
  });

  test('Linear 工具的结果中出现来源工单编号也记为 ticket（副本工单的旧正文末尾带 source: TXE-3635）', () => {
    const fromResult = refs.filter((r) => r.kind === 'ticket' && r.excerpt.startsWith('result: '));
    expect(fromResult.length).toBeGreaterThan(0);
    for (const r of fromResult) expect(r.excerpt).toContain('TXE-363');
  });

  test('按主 session seq 排序；每个 (调用, kind) 一条', () => {
    const seqs = refs.map((r) => r.requestSeq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const keys = refs.map((r) => `${r.toolCallId}\0${r.kind}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(refs.map((r) => r.kind))).toEqual(new Set(['ticket', 'pr', 'repo']));
  });

  test('没有读来源的 run：空数组', () => {
    expect(scanSourceRefs(db, cleanRunId)).toEqual([]);
  });
});
