import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { sessionSkillLoads } from '../src/bindings/index.js';
import { config } from '../src/config.js';
import { type Db, openDatabase } from '../src/db/index.js';
import { requests, sessions, userMessages } from '../src/db/schema.js';
import { events } from '../src/events.js';
import { codexHomeOf, ingestCodexFile, readSessionMeta } from '../src/ingest/codex.js';
import { exportSessionRows } from '../src/insights/export.js';
import { readReport } from '../src/stages/report.js';
import { createVariants } from '../src/variants/index.js';
import { createWorkflows } from '../src/workflows/index.js';

// Contracts 25.2：Codex rollout 的导入。样本是本机一个 codex exec 的真实 rollout（29 行，3 次请求，exec 脚本中
// cat 读取 history 的 SKILL.md、调用 wf-history 的两个 MCP 工具），去掉了用户名与注入的 AGENTS.md
// （.work/w62/sanitize-rollout.mjs）。复制进测试自己建的 CODEX_HOME，不读写用户的 ~/.codex
const fixture = path.join(
  import.meta.dirname,
  'fixtures/codex-rollouts/rollout-2026-10-04T20-22-00-01a106dd-2ba7-7e71-8490-0e170a634111.jsonl',
);
const sessionId = '01a106dd-2ba7-7e71-8490-0e170a634111';
// 样本中唯一的一条用户输入
const prompt =
  "Call the status tool of the wf-history MCP server, then its search tool with query 'wf install' and limit 1. Report the number of sources and whether search returned a hit.";
const work = path.join(config.repoRoot, '.work', 'test-ingest-codex', randomUUID());
const opened: Db[] = [];

afterAll(() => {
  for (const db of opened) db.$client.close();
  fs.rmSync(work, { recursive: true, force: true });
});

function openTestDb() {
  const db = openDatabase(path.join(work, `${randomUUID()}.sqlite`), config.migrationsDir);
  opened.push(db);
  return db;
}

// 样本复制到 <CODEX_HOME>/sessions/2026/10/04/
function copyRollout(content = fs.readFileSync(fixture, 'utf8')) {
  const file = path.join(work, randomUUID(), 'sessions/2026/10/04', path.basename(fixture));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function snapshot(db: Db) {
  return {
    session: db
      .select({
        engine: sessions.engine,
        cwd: sessions.cwd,
        title: sessions.title,
        startedAt: sessions.startedAt,
        endedAt: sessions.endedAt,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get(),
    requests: db
      .select()
      .from(requests)
      .where(eq(requests.sessionId, sessionId))
      .orderBy(asc(requests.seq))
      .all()
      // 自增 id 在不同的数据库中不同，比较时去掉
      .map((r) => ({ ...r, id: 0 })),
    users: db
      .select({ kind: userMessages.kind, text: userMessages.text })
      .from(userMessages)
      .where(eq(userMessages.sessionId, sessionId))
      .all(),
    skills: sessionSkillLoads(db, sessionId).map((s) => ({ ...s, id: 0 })),
  };
}

// 样本中 history 的 SKILL.md 全文（exec 脚本中 cat 的输出）
function skillFile(): string {
  for (const line of fs.readFileSync(fixture, 'utf8').split('\n')) {
    if (!line.includes('"CommandExecution"')) continue;
    const record = JSON.parse(line) as {
      payload: { item: { aggregated_output: string; command: string[] } };
    };
    if (record.payload.item.command.at(-1)?.endsWith('history/SKILL.md') === true)
      return record.payload.item.aggregated_output;
  }
  throw new Error('样本中没有读取 history 的 SKILL.md');
}

describe('导入 Codex rollout', () => {
  const db = openTestDb();
  const file = copyRollout();
  ingestCodexFile(db, file);
  const snap = snapshot(db);

  test('session_meta：session id、工作目录、开始时间；标题是第一条用户输入', () => {
    expect(readSessionMeta(file)).toEqual({
      id: sessionId,
      cwd: '/Users/tester/install-test2/.install/codex-probe',
      startedAt: new Date('2026-10-04T12:22:00.364Z'),
    });
    expect(snap.session).toMatchObject({
      engine: 'codex',
      cwd: '/Users/tester/install-test2/.install/codex-probe',
    });
    expect(snap.session?.title).toBe(Array.from(prompt).slice(0, 80).join(''));
    // 注入的 AGENTS.md 与环境说明不是用户输入
    expect(snap.users).toEqual([{ kind: 'user', text: prompt }]);
  });

  test('每个 token_usage_record 是一次请求：模型、token（input 去掉 cache 读写）、价格表中没有的模型只记 token', () => {
    expect(snap.requests.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(snap.requests.map((r) => r.model)).toEqual([
      'gpt-6-astra',
      'gpt-6-astra',
      'gpt-6-astra',
    ]);
    expect(
      snap.requests.map((r) => [
        r.inputTokens,
        r.cacheReadTokens,
        r.cacheCreationTokens,
        r.outputTokens,
      ]),
    ).toEqual([
      [3, 0, 17966, 138],
      [3, 17966, 3770, 42],
      [3, 21736, 6936, 28],
    ]);
    expect(snap.requests.map((r) => r.costUsd)).toEqual([0, 0, 0]);
    expect(snap.requests[0]?.text).toBe(
      'I’ll use the history skill to check wf-history’s status and search for `wf install` with a limit of 1.\n',
    );
    expect(snap.requests[2]?.text).toBe(
      'Status reported **316 indexed sources**. Search for `wf install` with limit 1 returned **1 hit**.',
    );
  });

  test('tool 调用：模型的 exec 调用带输出；exec 脚本中执行的命令与 MCP 工具另记在同一次请求中', () => {
    const calls = snap.requests.map((r) => r.toolCalls.map((c) => c.name));
    expect(calls).toEqual([
      ['exec', 'exec_command'],
      ['exec', 'mcp__wf-history__status', 'mcp__wf-history__search'],
      [],
    ]);
    const [exec, cat] = snap.requests[0]?.toolCalls ?? [];
    expect(exec?.result?.startsWith('Script completed')).toBe(true);
    expect(cat?.input).toEqual({
      cmd: 'cat /Users/tester/.codex/skills/history/SKILL.md',
      cwd: '/Users/tester/install-test2/.install/codex-probe',
    });
    expect(cat?.result).toBe(skillFile());
    expect(cat?.isError).toBe(false);
  });

  test('cat 读取 SKILL.md 是一次 skill 加载：名字为目录名，正文去掉 frontmatter', () => {
    expect(snap.skills).toMatchObject([
      {
        name: 'history',
        baseDir: '/Users/tester/.codex/skills/history',
        args: '',
      },
    ]);
    expect(skillFile().endsWith(snap.skills[0]?.text ?? '-')).toBe(true);
    expect(snap.skills[0]?.text.startsWith('---')).toBe(false);
  });

  test('再次导入没有变化；分两次增量导入（在第 N 行切开）与一次导入完全相同', () => {
    expect(ingestCodexFile(db, file).changed).toBe(false);
    expect(snapshot(db)).toEqual(snap);
    const lines = fs.readFileSync(fixture, 'utf8').split('\n');
    for (const cut of [8, 14, 17, 20]) {
      const incremental = openTestDb();
      const partial = copyRollout(`${lines.slice(0, cut).join('\n')}\n`);
      ingestCodexFile(incremental, partial);
      fs.writeFileSync(partial, fs.readFileSync(fixture, 'utf8'));
      ingestCodexFile(incremental, partial);
      expect(snapshot(incremental), `第 ${String(cut)} 行切开`).toEqual(snap);
    }
  });

  // 每段比最长的一行多 1 字节：一行比一段长时这一段读到文件末尾（readCompleteLines）
  test('分段导入（每段比最长的一行多 1 字节）与一次导入完全相同', () => {
    const chunked = openTestDb();
    const copy = copyRollout();
    const longest = Math.max(
      ...fs
        .readFileSync(fixture, 'utf8')
        .split('\n')
        .map((l) => Buffer.byteLength(l)),
    );
    let passes = 0;
    for (let more = true; more; passes++) more = ingestCodexFile(chunked, copy, longest + 1).more;
    expect(passes).toBeGreaterThan(3);
    expect(snapshot(chunked)).toEqual(snap);
  });
});

describe('Codex session 的绑定与阶段', { timeout: 300_000 }, () => {
  test('加载的 skill 与 variant 的 SKILL.md 逐字节一致时自动绑定，并按这个 workflow 划分阶段（cat 读取 SKILL.md 为标记）', () => {
    const db = openTestDb();
    const variants = createVariants({
      db,
      dataDir: config.dataDir,
      repo: config.txeWorkflowRepo,
      ctxBin: config.ctxBin,
    });
    const workflows = createWorkflows({ db, variants });
    const id = `w62probe${randomUUID().slice(0, 6)}`;
    workflows.create({
      id,
      name: 'W62 测量',
      description: '',
      definition: { id, name: 'W62 测量', stages: [{ id: 'history' }] },
    });
    const variant = variants.list().find((v) => v.workflowId === id);
    if (variant === undefined) throw new Error(`${id} 没有 variant`);
    variants.writeFile(variant.id, 'skills/history/SKILL.md', skillFile());

    const file = copyRollout();
    ingestCodexFile(db, file);
    const session = db
      .select({ variantId: sessions.variantId, binding: sessions.variantBinding })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();
    expect(session).toEqual({ variantId: variant.id, binding: 'auto' });
    const report = readReport(db, sessionId);
    const stage = report?.workflows
      .find((w) => w.workflow === id)
      ?.cycles[0]?.stages.find((s) => s.stage === 'history');
    expect(stage).toMatchObject({
      status: 'active',
      startSeq: 0,
      evidence: { seq: 0, kind: 'skill', text: 'Skill: history' },
    });

    // 分析的导出（Contracts 25.2）：格式与 Claude Code 的 session 相同
    const exported = exportSessionRows(db, sessionId);
    expect(exported.rows.map((r) => [r.seq, r.agent, r.parentSeq, r.model])).toEqual([
      [0, null, 0, 'gpt-6-astra'],
      [1, null, 1, 'gpt-6-astra'],
      [2, null, 2, 'gpt-6-astra'],
    ]);
    for (const r of exported.rows) expect(r.stage).toMatch(new RegExp(`^${id}#\\d+ history$`));
    expect(exported.rows[0]?.userMessagesBefore).toEqual([{ kind: 'user', text: prompt }]);
    expect(exported.rows[0]?.skillLoads).toEqual([{ name: 'history', args: '' }]);
    expect(exported.rows[0]?.toolCalls[1]).toMatchObject({
      name: 'exec_command',
      result: skillFile(),
      spilledOutput: null,
    });
    expect(exported.rows.map((r) => r.thinking)).toEqual([null, null, null]);
    // 样本中注入的全局 AGENTS.md：在这个 rollout 所在的 CODEX_HOME 下
    expect(exported.instructions).toEqual([
      {
        timestamp: '2026-10-04T12:22:01.682Z',
        files: [
          {
            path: path.join(codexHomeOf(file), 'AGENTS.md'),
            type: 'User',
            content: '测试样本中删去了本机的全局说明。',
          },
        ],
      },
    ]);
    fs.rmSync(variants.layout(variant.id).dir, { recursive: true, force: true });
  });
});

describe('Codex session 的分析导出', () => {
  // 在样本上改两处，得到本机较大的 rollout 中常见的两种情形：第一次 exec 的输出超过保存的长度（截断，导出时读回原文），
  // 第一次请求之前有一个只有加密内容的推理块（reasoning_output_tokens 为 120）
  test('截断的 tool 结果从 rollout 读回原文；推理块为 redacted_thinking，token 数取 reasoning_output_tokens', () => {
    const long = `Script completed\n${'0123456789'.repeat(3000)}`;
    const lines = fs.readFileSync(fixture, 'utf8').trimEnd().split('\n');
    const changed = lines.flatMap((line, i) => {
      const record = JSON.parse(line) as {
        timestamp: string;
        type: string;
        payload: { type?: string; output?: unknown; usage?: Record<string, number> };
      };
      if (record.payload.type === 'custom_tool_call_output' && i < 17) {
        record.payload.output = long;
        return [JSON.stringify(record)];
      }
      if (record.type === 'token_usage_record' && i < 17) {
        const reasoning = {
          timestamp: record.timestamp,
          type: 'response_item',
          payload: { type: 'reasoning', summary: [], encrypted_content: 'gAAAA' },
        };
        record.payload.usage = { ...record.payload.usage, reasoning_output_tokens: 120 };
        return [JSON.stringify(reasoning), JSON.stringify(record)];
      }
      return [line];
    });
    const db = openTestDb();
    ingestCodexFile(db, copyRollout(`${changed.join('\n')}\n`));
    const first = db
      .select({ toolCalls: requests.toolCalls })
      .from(requests)
      .where(eq(requests.sessionId, sessionId))
      .orderBy(asc(requests.seq))
      .get();
    expect(first?.toolCalls[0]?.result?.length).toBeLessThan(long.length);

    const { rows } = exportSessionRows(db, sessionId);
    expect(rows[0]?.toolCalls[0]?.result).toBe(long);
    expect(rows.map((r) => r.thinking)).toEqual([
      [{ type: 'redacted_thinking', tokens: 120 }],
      null,
      null,
    ]);
  });
});

describe('Codex session 的 session.updated', () => {
  test('只有 session_meta 与 task_started 时建出 session 也发出事件；没有新内容时不再发', () => {
    const lines = fs.readFileSync(fixture, 'utf8').split('\n');
    const db = openTestDb();
    const file = copyRollout(`${lines.slice(0, 2).join('\n')}\n`);
    const published: unknown[] = [];
    const unsubscribe = events.subscribe((e) => published.push(e));
    expect(ingestCodexFile(db, file).changed).toBe(false);
    expect(snapshot(db).session?.engine).toBe('codex');
    expect(snapshot(db).requests).toEqual([]);
    expect(published).toEqual([{ type: 'session.updated', sessionId }]);
    ingestCodexFile(db, file);
    unsubscribe();
    expect(published).toHaveLength(1);
  });
});
