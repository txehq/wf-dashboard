import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { config } from '../../src/config.js';
import { ingestFile } from '../../src/ingest/ingest.js';
import type { LiveDetail } from '../../src/live/views.js';
import { hookNames, type LiveServer, startLiveServer, terminalClient, until } from './harness.js';

// 工作目录的信任确认（Contracts 14.2），真实的 claude 与 PTY。每个用例 resume 一个短 session，收到 SessionStart
// 即结束进程，不调用模型。工作目录与"本机配置"的 HOME 每次运行新建在 .work/w39/real/ 下，从没有被信任过
const work = path.join(config.repoRoot, '.work', 'w39', 'real', randomUUID());
const home = path.join(work, 'home');
const fixture = path.join(
  import.meta.dirname,
  '../fixtures/live',
  'cfa31f10-e280-4908-bcf7-cbe9b00fbe53.jsonl',
);

const ClaudeJson = z.looseObject({
  projects: z
    .record(z.string(), z.looseObject({ hasTrustDialogAccepted: z.boolean().optional() }))
    .optional(),
});

let server: LiveServer;

beforeAll(async () => {
  fs.mkdirSync(home, { recursive: true });
  // 临时 HOME 已完成首次引导：启动后第一屏就是信任确认
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ hasCompletedOnboarding: true }),
  );
  server = await startLiveServer({ localHome: home });
}, 600_000);

afterAll(async () => {
  await server.close();
});

// fixture 的一份副本：新的 session id，记录的工作目录是一个新目录（resume 在这里启动）
function sessionIn(name: string): { sessionId: string; cwd: string } {
  const sessionId = randomUUID();
  const cwd = path.join(work, name);
  fs.mkdirSync(cwd, { recursive: true });
  const lines = fs
    .readFileSync(fixture, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const entry = z.looseObject({}).parse(JSON.parse(l));
      if ('sessionId' in entry) entry.sessionId = sessionId;
      if ('cwd' in entry) entry.cwd = cwd;
      return JSON.stringify(entry);
    });
  const projects = path.join(work, 'projects');
  fs.mkdirSync(projects, { recursive: true });
  const file = path.join(projects, `${sessionId}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  ingestFile(server.db, file);
  return { sessionId, cwd };
}

async function sessionStarted(id: string): Promise<LiveDetail> {
  return until('SessionStart', 120_000, async () => {
    const d = await server.detail(id);
    if (d.status === 'exited') throw new Error(`进程已退出：${JSON.stringify(d.events.at(-1))}`);
    return hookNames(d).includes('SessionStart') ? d : null;
  });
}

describe('信任确认（真实 claude，不调用模型）', { timeout: 600_000 }, () => {
  test('variant：从没信任过的新目录，resume 前写入 variant 的 .claude.json，不出现信任确认', async () => {
    const t0 = Date.now();
    const { sessionId, cwd } = sessionIn('variant-cwd');
    const file = path.join(server.variants.layout(server.variant.id).claudeDir, '.claude.json');
    const before = ClaudeJson.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    expect(before.projects?.[cwd]).toBeUndefined();
    const live = await server.api<LiveDetail>('POST', '/api/live/resume', {
      sessionId,
      variantId: server.variant.id,
      driver: 'human',
    });
    expect(live.cwd).toBe(cwd);
    const after = ClaudeJson.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    expect(after.projects?.[cwd]?.hasTrustDialogAccepted).toBe(true);
    const client = terminalClient(server.url, live.id);
    await client.opened;
    await until('SessionStart', 120_000, async () => {
      // 出现时没有人回答，它会一直停在屏幕上
      expect((await client.screen()).join('\n')).not.toContain('Yes, I trust this folder');
      return hookNames(await server.detail(live.id)).includes('SessionStart') ? true : null;
    });
    const started = await sessionStarted(live.id);
    expect(started.events.filter((e) => e.kind === 'trust')).toEqual([]);
    client.close();
    expect((await server.api<LiveDetail>('POST', `/api/live/${live.id}/stop`)).status).toBe(
      'exited',
    );
    console.info(`[W39] variant 信任：${String(Math.round((Date.now() - t0) / 1000))} s，$0`);
  });

  test('本机配置（临时 HOME）：不改 .claude.json，屏幕副本上出现信任确认时自动选择信任，记 trust 事件', async () => {
    const t0 = Date.now();
    const { sessionId, cwd } = sessionIn('local-cwd');
    const homeJson = path.join(home, '.claude.json');
    const before = fs.readFileSync(homeJson, 'utf8');
    const live = await server.api<LiveDetail>('POST', '/api/live/resume', {
      sessionId,
      variantId: null,
      driver: 'human',
    });
    // 启动前不写入 HOME 下的 .claude.json
    expect(fs.readFileSync(homeJson, 'utf8')).toBe(before);
    const started = await sessionStarted(live.id);
    const trust = started.events.filter((e) => e.kind === 'trust');
    expect(trust).toHaveLength(1);
    expect(trust[0]?.payload.cwd).toBe(cwd);
    // 回答时服务端屏幕副本上的确认：光标已在"Yes, I trust this folder"上
    const screen = z.array(z.string()).parse(trust[0]?.payload.screen).join('\n');
    expect(screen).toContain('Is this a project you created or one you trust?');
    expect(screen).toMatch(/❯.*Yes, I trust this folder/u);
    // 信任由 Claude Code 自己记进临时 HOME 的 .claude.json
    const after = ClaudeJson.parse(JSON.parse(fs.readFileSync(homeJson, 'utf8')));
    const trusted = Object.values(after.projects ?? {}).filter(
      (p) => p.hasTrustDialogAccepted === true,
    );
    expect(trusted.length).toBeGreaterThan(0);
    expect((await server.api<LiveDetail>('POST', `/api/live/${live.id}/stop`)).status).toBe(
      'exited',
    );
    console.info(`[W39] 本机配置信任：${String(Math.round((Date.now() - t0) / 1000))} s，$0`);
  });
});
