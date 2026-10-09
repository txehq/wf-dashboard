import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, describe, expect, test } from 'vitest';
import { sessionsRoutes } from '../src/api/sessions.js';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';

const samplesDir = '/Users/linhaoz/orca/projects/wf-dashboard/.spikes/stage-markers/samples';
const txe = '-Users-linhaoz-Project-txe-txe-workflow';
const dashboard = '-Users-linhaoz-orca-projects-wf-dashboard';
const f0 = 'f0aca373-863f-4d62-babd-f48055092328';
const d93 = 'd93c4511-3c62-4b3b-8ee6-bf73370cd150';
const n9f = '9f4adf2d-0730-4214-994a-4fba7f7b9161';

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

// ~/.claude/projects 的副本：txe-workflow 两个 session；variant v1 的 home/claude/projects 中放 d93c4511
copy(txe, f0, projectsDir);
copy(txe, n9f, projectsDir);
mkdirSync(path.join(projectsDir, dashboard));
copy(dashboard, d93, path.join(variantsDir, 'v1', 'home', 'claude', 'projects'));

const db = openDatabase(path.join(workDir, 'db.sqlite'), config.migrationsDir);
const app = Fastify();
await app.register(sessionsRoutes, { prefix: '/api', db, dirs: { projectsDir, variantsDir } });

afterAll(async () => {
  await app.close();
  db.$client.close();
  rmSync(workDir, { recursive: true, force: true });
});

interface Summary {
  id: string;
  title: string | null;
  source: string | null;
  requestCount: number;
  workflows: string[];
  costUsd: number;
}

async function get<T>(url: string) {
  const response = await app.inject({ method: 'GET', url });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}

interface SourceBody {
  path: string;
  variant: string | null;
  sessionCount: number;
  checked: boolean;
}

describe('sessions api', () => {
  test('GET /api/sources 列出 ~/.claude/projects 与 variant 目录', async () => {
    const sources = await get<SourceBody[]>('/api/sources');
    expect(sources).toEqual([
      expect.objectContaining({
        path: path.join(projectsDir, txe),
        variant: null,
        sessionCount: 2,
        checked: false,
      }),
      expect.objectContaining({
        path: path.join(projectsDir, dashboard),
        variant: null,
        sessionCount: 0,
        checked: false,
      }),
      expect.objectContaining({
        path: path.join(variantsDir, 'v1', 'home', 'claude', 'projects', dashboard),
        variant: 'v1',
        sessionCount: 1,
        checked: true,
      }),
    ]);
  });

  test('PUT /api/sources 拒绝 ~/.claude/projects 以外的目录', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/sources',
      payload: { paths: ['/etc'] },
    });
    expect(response.statusCode).toBe(400);
  });

  test('PUT /api/sources 勾选后导入，GET /api/sessions 返回勾选来源与 variant 的 session', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/sources',
      payload: { paths: [path.join(projectsDir, txe)] },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ imported: { files: number; changedSessions: number } }>();
    expect(body.imported).toMatchObject({ files: 3, changedSessions: 3 });

    const { sessions, nextCursor } = await get<{ sessions: Summary[]; nextCursor: string | null }>(
      '/api/sessions',
    );
    expect(nextCursor).toBeNull();
    expect(sessions.map((s) => s.id).sort()).toEqual([d93, f0, n9f].sort());
    const byId = new Map(sessions.map((s) => [s.id, s]));
    // f0aca373 含 open-pr / fix-pr / gh pr；d93c4511 含 Skill interview；9f4adf2d 两者都没有
    expect(byId.get(f0)?.workflows).toEqual(['lfg', 'ic']);
    expect(byId.get(d93)?.workflows).toEqual(['lfg']);
    expect(byId.get(n9f)?.workflows).toEqual([]);
    expect(byId.get(d93)?.source).toBe(
      path.join(variantsDir, 'v1', 'home', 'claude', 'projects', dashboard),
    );
    for (const s of sessions) {
      expect(s.requestCount).toBeGreaterThan(0);
      expect(s.costUsd).toBeGreaterThan(0);
      expect(Array.from(s.title ?? '').length).toBeLessThanOrEqual(80);
    }
  });

  test('GET /api/sessions 的 workflow、q、limit 与 cursor', async () => {
    const ic = await get<{ sessions: Summary[] }>('/api/sessions?workflow=ic');
    expect(ic.sessions.map((s) => s.id)).toEqual([f0]);

    const q = await get<{ sessions: Summary[] }>(`/api/sessions?q=${n9f.slice(0, 8)}`);
    expect(q.sessions.map((s) => s.id)).toEqual([n9f]);

    const source = await get<{ sessions: Summary[] }>(
      `/api/sessions?source=${encodeURIComponent(path.join(projectsDir, txe))}`,
    );
    expect(source.sessions.map((s) => s.id).sort()).toEqual([f0, n9f].sort());

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
    expect(seen.sort()).toEqual([d93, f0, n9f].sort());
  });

  test('GET /api/sessions/:id 汇总子代理与 tool 调用次数', async () => {
    const detail = await get<{
      subagentCount: number;
      toolCallCount: number;
      toolCounts: Record<string, number>;
      subagents: { agentId: string; requestCount: number }[];
    }>(`/api/sessions/${f0}`);
    expect(detail.subagentCount).toBe(1);
    expect(detail.subagents[0]?.agentId).toBe('a1a09a912d9ef185a');
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
    const { items } = await get<{ items: Item[] }>(`/api/sessions/${f0}/requests`);
    const reqs = items.filter((i) => i.kind === 'request');
    expect(reqs.every((r) => r.agentId === null)).toBe(true);
    expect(reqs.map((r) => r.seq)).toEqual(reqs.map((_, i) => i));
    expect(items.some((i) => i.kind === 'user')).toBe(true);
    // f0aca373 中 fix-pr 的后台 watcher 以 task-notification 唤醒 agent
    expect(items.some((i) => i.kind === 'notice' && i.text.startsWith('<task-notification>'))).toBe(
      true,
    );
    const times = items.map((i) => Date.parse(i.timestamp));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(
      reqs.flatMap((r) => r.toolCalls).filter((c) => c.subagentId === 'a1a09a912d9ef185a').length,
    ).toBe(1);

    const sub = await get<{ items: Item[] }>(
      `/api/sessions/${f0}/requests?agent=a1a09a912d9ef185a`,
    );
    const subReqs = sub.items.filter((i) => i.kind === 'request');
    expect(subReqs.length).toBeGreaterThan(0);
    expect(subReqs.every((r) => r.agentId === 'a1a09a912d9ef185a')).toBe(true);

    const range = await get<{ items: Item[] }>(`/api/sessions/${f0}/requests?fromSeq=10&toSeq=19`);
    expect(range.items.filter((i) => i.kind === 'request').map((r) => r.seq)).toEqual([
      10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    ]);
  });

  test('取消勾选后该来源的 session 不再出现，variant 的 session 仍在', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/sources',
      payload: { paths: [] },
    });
    expect(response.statusCode).toBe(200);
    const { sessions } = await get<{ sessions: Summary[] }>('/api/sessions');
    expect(sessions.map((s) => s.id)).toEqual([d93]);
  });
});
