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
    workflowId: 'dev-workflow',
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
      model: 'opus',
      effort: 'high',
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

  test('只记访问来源的动作：W28 的 session 中只有上面三处；读副本工单、在 PR 正文与文件中引用正文里的仓库名都不记', () => {
    expect(refs.map((r) => r.kind)).toEqual(['ticket', 'ticket', 'pr']);
    const seqs = refs.map((r) => r.requestSeq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  test('没有读来源的 run：空数组', () => {
    expect(scanSourceRefs(db, cleanRunId)).toEqual([]);
  });

  test('构造的调用：引用不记，访问记；pr 只匹配工单关联的编号', () => {
    const row = db
      .select()
      .from(requests)
      .where(and(eq(requests.sessionId, cleanSessionId), isNull(requests.agentId)))
      .all()[3];
    if (row === undefined) throw new Error('对照 session 的请求不足 4 条');
    const call = (id: string, name: string, input: unknown) => ({
      id,
      name,
      input,
      result: 'ok',
      resultChars: 2,
      isError: false,
      spillPath: null,
      subagentId: null,
    });
    const constructed = [
      // 引用：PR 正文、提交信息、写进文件的内容、回复给 Linear 的评论正文里的仓库名
      call('toolu_quote_body', 'Bash', {
        command:
          'gh pr create --title "fix release label" --body "Same fix as txehq/tokun-cn PR 638: allow @ and +"',
      }),
      call('toolu_quote_commit', 'Bash', {
        command: 'git commit -m "fix: accept release labels like txehq/tokun-cn/pull/638 did"',
      }),
      call('toolu_quote_write', 'Write', {
        file_path: 'NOTES.md',
        content: 'One PR in txehq/tokun-cn validator-site/frontend.',
      }),
      // 访问
      call('toolu_fetch_pr', 'WebFetch', {
        url: 'https://github.com/txehq/tokun-cn/pull/638/files',
        prompt: 'diff',
      }),
      call('toolu_api_repo', 'Bash', {
        command: 'gh api repos/txehq/tokun-cn/contents/README.md --jq .content | base64 -d',
      }),
      // 638 以外的 PR 编号不是来源 PR：记为 repo
      call('toolu_other_pr', 'Bash', { command: 'gh pr view 999 --repo txehq/tokun-cn' }),
    ];
    db.update(requests)
      .set({ toolCalls: [...row.toolCalls, ...constructed] })
      .where(eq(requests.id, row.id))
      .run();
    const found = scanSourceRefs(db, cleanRunId);
    db.update(requests).set({ toolCalls: row.toolCalls }).where(eq(requests.id, row.id)).run();
    expect(found.map((r) => [r.toolCallId, r.kind, r.requestSeq])).toEqual([
      ['toolu_fetch_pr', 'pr', row.seq],
      ['toolu_api_repo', 'repo', row.seq],
      ['toolu_other_pr', 'repo', row.seq],
    ]);
    expect(found[0]?.excerpt).toBe('url: https://github.com/txehq/tokun-cn/pull/638/files');
  });
});
