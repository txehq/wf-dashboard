import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, describe, expect, test } from 'vitest';
import { sessionsRoutes } from '../src/api/sessions.js';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { variants } from '../src/db/schema.js';
import { tailSessions } from '../src/ingest/session-import.js';
import { unpackRunFixture } from './helpers/run-fixture.js';
import { IC } from './helpers/session-fixtures.js';
import { testSourceDirs } from './helpers/source-dirs.js';
import { samplesDir } from './stages/samples.js';

const txe = '-Users-linhaoz-Project-txe-txe-workflow';
const dashboard = '-Users-linhaoz-orca-projects-wf-dashboard';
// ic run r-20261009-27yz3d 的 session（主 jsonl 768 KB）：有 claim、open-pr 等 Skill 调用与一个子代理
const icId = IC.sessionId;
const icAgent = 'afe33664422ac1395';
// 有 task-notification 的真实 session（2 MB），放在 variant v1 的配置中
const d93 = 'd93c4511-3c62-4b3b-8ee6-bf73370cd150';
// 没有 lfg 与 ic 标记的真实 session（peer 消息的样本，61 KB）
const peer = 'b7199c56-42d6-4dda-ac96-117d3937ebdd';

const workDir = path.join(config.repoRoot, '.work', 'test-sessions-api', randomUUID());
const projectsDir = path.join(workDir, 'projects');
const variantsDir = path.join(workDir, 'variants');

function copy(slug: string, id: string, targetProjects: string) {
  cpSync(
    path.join(samplesDir, slug, `${id}.jsonl`),
    path.join(targetProjects, slug, `${id}.jsonl`),
  );
  cpSync(path.join(samplesDir, slug, id), path.join(targetProjects, slug, id), { recursive: true });
}

// ~/.claude/projects 的副本：txe-workflow 下 ic 与 peer 两个 session；variant v1 的 home/claude/projects 中放 d93c4511
unpackRunFixture(IC.runId, icId, path.join(projectsDir, txe));
cpSync(
  path.join(import.meta.dirname, 'fixtures/peer', `${peer}.jsonl`),
  path.join(projectsDir, txe, `${peer}.jsonl`),
);
mkdirSync(path.join(projectsDir, dashboard));
copy(dashboard, d93, path.join(variantsDir, 'v1', 'home', 'claude', 'projects'));

const db = openDatabase(path.join(workDir, 'db.sqlite'), config.migrationsDir);
// variant v1 的记录：它的配置目录（variants/v1/home/claude/projects）属于 dashboard 自己的配置
db.insert(variants)
  .values({ id: 'v1', name: 'v1', workflowId: 'ic', baseCommit: '', skillsHash: '', version: '' })
  .run();
const dirs = testSourceDirs(workDir, { projectsDir, variantsDir });
const app = Fastify();
await app.register(sessionsRoutes, { prefix: '/api', db, dirs });

afterAll(async () => {
  await app.close();
  db.$client.close();
  rmSync(workDir, { recursive: true, force: true });
});

interface Summary {
  id: string;
  title: string | null;
  requestCount: number;
  engine: 'claude' | 'codex';
  config: string;
  workflows: string[];
  costUsd: number;
}

async function get<T>(url: string) {
  const response = await app.inject({ method: 'GET', url });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}

describe('sessions api', () => {
  test('GET /api/session-import/configs 列出本机配置与 variant 的配置', async () => {
    const { configs } = await get<{ configs: unknown[] }>('/api/session-import/configs');
    expect(configs).toEqual([
      { id: 'local', label: '本机配置', workflow: null, sessionCount: 2 },
      { id: 'variant:v1', label: 'v1', workflow: { id: 'ic', name: 'ic' }, sessionCount: 1 },
    ]);
  });

  test('POST /api/session-import 拒绝配置以外的文件', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/session-import',
      payload: { files: ['/etc/passwd'] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ message: string }>().message).toContain('/etc/passwd');
  });

  test('导入本机的两个 session，variant 目录的 session 由增量导入自动导入，GET /api/sessions 返回三个', async () => {
    const files = [icId, peer].map((id) => path.join(projectsDir, txe, `${id}.jsonl`));
    const response = await app.inject({
      method: 'POST',
      url: '/api/session-import',
      payload: { files },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      sessions: [
        { id: icId, file: files[0] },
        { id: peer, file: files[1] },
      ],
    });
    expect(await tailSessions(db, dirs)).toBe(1);

    const { sessions, nextCursor } = await get<{ sessions: Summary[]; nextCursor: string | null }>(
      '/api/sessions',
    );
    expect(nextCursor).toBeNull();
    expect(sessions.map((s) => s.id).sort()).toEqual([d93, icId, peer].sort());
    const byId = new Map(sessions.map((s) => [s.id, s]));
    // workflow 列只按 dashboard 记录的 workflow 配置显示（Contracts 25.4）：本机配置下的 ic 与 peer 没有，
    // 即使 ic 的 session 中有 Skill claim 与 open-pr；variant v1 配置下的取 v1 的 workflow
    expect(byId.get(icId)).toMatchObject({ engine: 'claude', config: 'local', workflows: [] });
    expect(byId.get(peer)).toMatchObject({ config: 'local', workflows: [] });
    expect(byId.get(d93)).toMatchObject({ config: 'variant:v1', workflows: ['ic'] });
    for (const s of sessions) {
      expect(s.requestCount).toBeGreaterThan(0);
      expect(s.costUsd).toBeGreaterThan(0);
      expect(Array.from(s.title ?? '').length).toBeLessThanOrEqual(80);
    }
  });

  test('GET /api/sessions 的 workflow、q、config、limit 与 cursor', async () => {
    const ic = await get<{ sessions: Summary[] }>('/api/sessions?workflow=ic');
    expect(ic.sessions.map((s) => s.id)).toEqual([icId]);

    const q = await get<{ sessions: Summary[] }>(`/api/sessions?q=${peer.slice(0, 8)}`);
    expect(q.sessions.map((s) => s.id)).toEqual([peer]);
    // W15 Low 19：% 与 _ 按字面匹配，不是通配符
    for (const wildcard of ['%', '_']) {
      const literal = await get<{ sessions: Summary[] }>(
        `/api/sessions?q=${encodeURIComponent(wildcard)}`,
      );
      expect(literal.sessions, wildcard).toEqual([]);
    }

    const local = await get<{ sessions: Summary[] }>('/api/sessions?config=local');
    expect(local.sessions.map((s) => s.id).sort()).toEqual([icId, peer].sort());

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? '' : `&cursor=${cursor}`;
      const page: { sessions: Summary[]; nextCursor: string | null } = await get(
        `/api/sessions?limit=1${query}`,
      );
      expect(page.sessions.length).toBe(1);
      seen.push(...page.sessions.map((s) => s.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen.sort()).toEqual([d93, icId, peer].sort());
  });

  test('GET /api/sessions/:id 汇总子代理与 tool 调用次数', async () => {
    const detail = await get<{
      subagentCount: number;
      toolCallCount: number;
      toolCounts: Record<string, number>;
      subagents: { agentId: string; requestCount: number }[];
    }>(`/api/sessions/${icId}`);
    expect(detail.subagentCount).toBe(1);
    expect(detail.subagents[0]?.agentId).toBe(icAgent);
    expect(Object.values(detail.toolCounts).reduce((a, b) => a + b, 0)).toBe(detail.toolCallCount);
    expect(detail.toolCounts.Skill).toBeGreaterThan(0);

    const missing = await app.inject({ method: 'GET', url: '/api/sessions/nope' });
    expect(missing.statusCode).toBe(404);
  });

  test('GET /api/sessions/:id/requests 按时间插入用户消息，子代理行单独返回', async () => {
    type Item =
      | { kind: 'user' | 'notice'; text: string; timestamp: string }
      | {
          kind: 'request';
          seq: number;
          agentId: string | null;
          timestamp: string;
          toolCalls: { subagentId: string | null }[];
        };
    const { items } = await get<{ items: Item[] }>(`/api/sessions/${icId}/requests`);
    const reqs = items.filter((i) => i.kind === 'request');
    expect(reqs.every((r) => r.agentId === null)).toBe(true);
    expect(reqs.map((r) => r.seq)).toEqual(reqs.map((_, i) => i));
    expect(items.some((i) => i.kind === 'user')).toBe(true);
    const times = items.map((i) => Date.parse(i.timestamp));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(reqs.flatMap((r) => r.toolCalls).filter((c) => c.subagentId === icAgent).length).toBe(1);

    const sub = await get<{ items: Item[] }>(`/api/sessions/${icId}/requests?agent=${icAgent}`);
    const subReqs = sub.items.filter((i) => i.kind === 'request');
    expect(subReqs.length).toBeGreaterThan(0);
    expect(subReqs.every((r) => r.agentId === icAgent)).toBe(true);

    // d93c4511 中后台命令结束时以 task-notification 唤醒 agent
    const notified = await get<{ items: Item[] }>(`/api/sessions/${d93}/requests`);
    expect(
      notified.items.some((i) => i.kind === 'notice' && i.text.startsWith('<task-notification>')),
    ).toBe(true);

    const range = await get<{ items: Item[] }>(
      `/api/sessions/${icId}/requests?fromSeq=10&toSeq=19`,
    );
    expect(range.items.filter((i) => i.kind === 'request').map((r) => r.seq)).toEqual([
      10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    ]);
    // W15 Medium 5：端点不存在时以前去掉这一侧的界限，返回 0 条请求加上从头开始的全部用户消息
    for (const query of ['fromSeq=1000000', 'toSeq=1000000']) {
      const missing = await app.inject({
        method: 'GET',
        url: `/api/sessions/${icId}/requests?${query}`,
      });
      expect(missing.statusCode, query).toBe(404);
      expect(missing.json<{ error: string }>().error).toContain('没有请求 #');
    }
  });
});
