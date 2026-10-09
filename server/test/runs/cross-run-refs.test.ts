import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { config } from '../../src/config.js';
import { batches, requests, runs, type ToolCall, variants } from '../../src/db/schema.js';
import { ingestFile } from '../../src/ingest/ingest.js';
import { scanCrossRunRefs } from '../../src/runs/cross-run-refs.js';
import { RunDetail, RunSummary } from '../../src/runs/views.js';
import { syncTasks } from '../../src/tasks/loader.js';
import { insertSession, openTestDb } from '../stages/db.js';

// W4 端到端的 lfg run r-20261009-dqva52 的真实 session（含 18 个子代理）：research 的 Explore 子代理读取了
// ic run r-20261009-qujfww 的仓库 txehq/wfe-r-20261009-qujfww，ticketing 把它的工单 TXE-3761 从 related 中移除
const sessionId = '0188c133-3e7b-4592-a963-fc717cf283de';
const lfgRunId = 'r-20261009-dqva52';
const icRunId = 'r-20261009-qujfww';
const fixture = path.join(import.meta.dirname, '../fixtures/runs', lfgRunId);
const work = path.join(config.repoRoot, '.work', 'test-cross-run-refs', randomUUID());

// fixture 逐个文件 gzip 保存，解压到 .work 下保持原目录结构
for (const entry of fs.readdirSync(fixture, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const from = path.join(entry.parentPath, entry.name);
  const to = path.join(work, path.relative(fixture, from).replace(/\.gz$/, ''));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, zlib.gunzipSync(fs.readFileSync(from)));
}

const { db, close } = openTestDb();
syncTasks(db, config.tasksDir);
const variantId = randomUUID();
db.insert(variants)
  .values({
    id: variantId,
    name: `cross-ref-${variantId.slice(0, 8)}`,
    baseCommit: '0'.repeat(40),
    skillsHash: 'a'.repeat(64),
    version: '0.0.0-eval.aaaaaaaa',
    model: 'opus',
    effort: 'high',
  })
  .run();
db.insert(batches).values({ id: 'b-20261009-crossr', repeats: 1 }).run();

function insertRunRow(
  id: string,
  taskId: string,
  repeatIndex: number,
  session: string,
  ticket: string | null = null,
) {
  db.insert(runs)
    .values({
      id,
      batchId: 'b-20261009-crossr',
      taskId,
      variantId,
      repeatIndex,
      status: 'failed',
      sessionId: session,
      workspacePath: path.join(work, id, 'workspace'),
      linearIssueIdentifier: ticket,
      githubRepo: `txehq/wfe-${id}`,
    })
    .run();
}

insertRunRow(icRunId, 'ic-money-format', 0, '9c223056-4607-4674-a203-f9f8cb36310a', 'TXE-3761');
insertRunRow(lfgRunId, 'lfg-calculator', 0, sessionId);
ingestFile(db, path.join(work, `${sessionId}.jsonl`));

const app = await buildApp({
  db,
  sseHeartbeatMs: config.sseHeartbeatMs,
  logger: false,
  tasksDir: config.tasksDir,
});

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
  close();
  fs.rmSync(work, { recursive: true, force: true });
});

// 主 session 中带这个 tool 调用的请求 seq
function mainSeqOf(session: string, toolCallId: string): number {
  const row = db
    .select()
    .from(requests)
    .where(and(eq(requests.sessionId, session), isNull(requests.agentId)))
    .all()
    .find((r) => r.toolCalls.some((c) => c.id === toolCallId));
  if (row === undefined) throw new Error(`主 session 中没有 ${toolCallId}`);
  return row.seq;
}

function inputs(session: string): string {
  return db
    .select()
    .from(requests)
    .where(eq(requests.sessionId, session))
    .all()
    .flatMap((r) => r.toolCalls.map((c) => JSON.stringify(c.input)))
    .join('\n');
}

// Explore 子代理 "Reuse lens explorer"（agent-aa55d873bc85506f1）由主 session 的这个 Agent 调用发起
const REUSE_EXPLORER = 'toolu_01THDWxnUAuE7Pg3MFZ9TDNk';

describe('运行之间的参考（Contracts 7.11）：真实 session', () => {
  const refs = scanCrossRunRefs(db, lfgRunId);

  test('research 子代理读取 txehq/wfe-r-20261009-qujfww：kind repo，requestSeq 为发起子代理的主 session 请求', () => {
    const seq = mainSeqOf(sessionId, REUSE_EXPLORER);
    const explorer = refs.filter((r) => r.requestSeq === seq);
    expect(explorer.map((r) => [r.runId, r.kind, r.toolCallId])).toEqual([
      [icRunId, 'repo', 'toolu_01Wrd6U9Gtrzv4R7e1EhYnZ5'],
      [icRunId, 'repo', 'toolu_01CsP5iwfDA3G3UCxJADUnUk'],
      [icRunId, 'repo', 'toolu_019PGDRdW36ywnPFx2unVeR9'],
    ]);
    expect(explorer[2]?.excerpt).toContain('command: cd /tmp; R=txehq/wfe-r-20261009-qujfww;');
  });

  test('ticketing 中 save_issue 的 removeRelatedTo 含 TXE-3761：kind ticket', () => {
    const ticket = refs.find((r) => r.toolCallId === 'toolu_01SF87vb76cj2DXeQUozrJhn');
    expect(ticket).toEqual({
      runId: icRunId,
      kind: 'ticket',
      requestSeq: mainSeqOf(sessionId, 'toolu_01SF87vb76cj2DXeQUozrJhn'),
      toolCallId: 'toolu_01SF87vb76cj2DXeQUozrJhn',
      excerpt: 'removeRelatedTo[0]: TXE-3761',
    });
  });

  test('引用自己的仓库不算；不在 runs 表中的 run 不算；全部引用都指向 qujfww 且按 requestSeq 排序', () => {
    const all = inputs(sessionId);
    expect(all).toContain(`txehq/wfe-${lfgRunId}`);
    expect(all).toContain('wfe-r-20261009-a9piql');
    expect(refs.every((r) => r.runId === icRunId)).toBe(true);
    expect(new Set(refs.map((r) => r.kind))).toEqual(new Set(['repo', 'ticket']));
    const seqs = refs.map((r) => r.requestSeq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  test('GET /api/runs 与 GET /api/runs/:id 返回 crossRunRefs', async () => {
    db.update(runs).set({ crossRunRefs: refs }).where(eq(runs.id, lfgRunId)).run();
    const list = await app.inject({ method: 'GET', url: '/api/runs' });
    expect(list.statusCode).toBe(200);
    const summaries = RunSummary.array().parse(list.json());
    expect(summaries.find((r) => r.id === lfgRunId)?.crossRunRefs).toEqual(refs);
    expect(summaries.find((r) => r.id === icRunId)?.crossRunRefs).toEqual([]);
    const detail = await app.inject({ method: 'GET', url: `/api/runs/${lfgRunId}` });
    expect(detail.statusCode).toBe(200);
    expect(RunDetail.parse(detail.json()).crossRunRefs).toEqual(refs);
  });
});

function call(name: string, input: unknown): ToolCall {
  return {
    id: `toolu_${randomUUID()}`,
    name,
    input,
    result: 'ok',
    resultChars: 2,
    isError: false,
    spillPath: null,
    subagentId: null,
  };
}

describe('运行之间的参考：vault、other 与边界', () => {
  const runId = 'r-20261010-probe1';
  const probeSession = randomUUID();
  const vault = `/Users/x/Vault/Project Magi Eval/Features/${icRunId}/Brief.md`;
  const calls = [
    call('Read', { file_path: vault }),
    call('Bash', { command: `echo ${icRunId}` }),
    call('Bash', { command: `gh repo view txehq/wfe-${icRunId}x` }),
    call('Bash', { command: `gh repo view txehq/wfe-${runId}` }),
    call('Bash', { command: 'gh issue view TXE-3761 --repo txehq/x' }),
    call('mcp__capso-linear__get_issue', { id: 'TXE-37612' }),
  ];
  beforeAll(() => {
    insertRunRow(runId, 'lfg-calculator', 1, probeSession);
    const [template] = db.select().from(requests).where(eq(requests.sessionId, sessionId)).all();
    if (template === undefined) throw new Error('没有请求行');
    insertSession(
      db,
      probeSession,
      calls.map((c, seq) => ({
        ...template,
        messageId: `msg_${String(seq)}`,
        seq,
        agentId: null,
        toolCalls: [c],
      })),
      null,
    );
  });

  test('Features/<id> 为 vault；单独出现的 id 为 other；id 后接字母数字、自己的 run、非 Linear 工具中的工单号都不算', () => {
    const refs = scanCrossRunRefs(db, runId);
    expect(refs.map((r) => [r.toolCallId, r.runId, r.kind, r.requestSeq])).toEqual([
      [calls[0]?.id, icRunId, 'vault', 0],
      [calls[1]?.id, icRunId, 'other', 1],
    ]);
    expect(refs[0]?.excerpt).toBe(`file_path: ${vault}`);
  });
});
