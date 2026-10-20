import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { execa } from 'execa';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import { liveProcesses, sessions } from '../../src/db/schema.js';
import { ingestFile } from '../../src/ingest/ingest.js';
import type { LiveDetail } from '../../src/live/views.js';
import { type LiveServer, startLiveServer, until } from './harness.js';

// Contracts 16.5：交互进程的 --model 与 --effort 取设置的 agentModel 与 agentEffort，live_processes 记下实际值；
// 本机配置不传这两个参数，记为空。基础档 PATH 中的 claude 记下调用后退出，这里只看启动参数与记录
const work = path.join(config.repoRoot, '.work/w36/live-model', randomUUID());
const cwd = path.join(work, 'cwd');
const home = path.join(work, 'home');
// 本机导入的 session（与 live-import.test.ts 相同的 fixture），工作目录改为这里的 cwd
const fixtureSession = 'cfa31f10-e280-4908-bcf7-cbe9b00fbe53';
const original = path.join(work, 'projects', 'p', `${fixtureSession}.jsonl`);

let server: LiveServer;

beforeAll(async () => {
  fs.mkdirSync(cwd, { recursive: true });
  await execa('git', ['init', '-q', cwd]);
  fs.mkdirSync(path.dirname(original), { recursive: true });
  fs.copyFileSync(
    path.join(import.meta.dirname, '../fixtures/live', `${fixtureSession}.jsonl`),
    original,
  );
  server = await startLiveServer({ localHome: home });
}, 600_000);

afterAll(async () => {
  await server.close();
  fs.rmSync(work, { recursive: true, force: true });
});

const exited = (id: string) =>
  until('进程退出', 30_000, async () => {
    const d = await server.detail(id);
    return d.status === 'exited' ? d : null;
  });

const processesOf = (liveId: string) =>
  server.db
    .select({
      kind: liveProcesses.kind,
      variantId: liveProcesses.variantId,
      model: liveProcesses.model,
      effort: liveProcesses.effort,
    })
    .from(liveProcesses)
    .where(eq(liveProcesses.liveId, liveId))
    .all();

test('variant 启动用设置的 model 与 effort 并记下；本机配置 resume 不传，记为空', async () => {
  server.settings.set({ ...server.settings.get(), agentModel: 'sonnet', agentEffort: 'max' });
  const created = await server.api<LiveDetail>('POST', '/api/live', {
    workflow: 'lfg',
    input: '做一个计算器',
    variantId: server.variant.id,
    environment: 'real',
    cwd,
    driver: 'human',
  });
  const started = await exited(created.id);
  expect(started.events.find((e) => e.kind === 'start')?.payload.argv).toEqual(
    expect.arrayContaining(['--model', 'sonnet', '--effort', 'max']),
  );
  expect(processesOf(created.id)).toEqual([
    { kind: 'start', variantId: server.variant.id, model: 'sonnet', effort: 'max' },
  ]);

  // 新建时选的 model 与 effort（Contracts 16.5）
  const chosen = await server.api<LiveDetail>('POST', '/api/live', {
    workflow: 'lfg',
    input: '做一个计算器',
    variantId: server.variant.id,
    environment: 'real',
    cwd,
    driver: 'human',
    model: 'haiku',
    effort: 'low',
  });
  const chosenStart = await exited(chosen.id);
  expect(chosenStart.events.find((e) => e.kind === 'start')?.payload.argv).toEqual(
    expect.arrayContaining(['--model', 'haiku', '--effort', 'low', '/lfg 做一个计算器']),
  );
  expect(processesOf(chosen.id)).toEqual([
    { kind: 'start', variantId: server.variant.id, model: 'haiku', effort: 'low' },
  ]);

  ingestFile(server.db, original);
  server.db.update(sessions).set({ cwd }).where(eq(sessions.id, fixtureSession)).run();
  const resumed = await server.api<LiveDetail>('POST', '/api/live/resume', {
    sessionId: fixtureSession,
    variantId: null,
    driver: 'human',
  });
  const local = await exited(resumed.id);
  const argv = local.events.find((e) => e.kind === 'resume')?.payload.argv;
  expect(argv).not.toContain('--model');
  expect(argv).not.toContain('--effort');
  expect(processesOf(resumed.id)).toEqual([
    { kind: 'resume', variantId: null, model: null, effort: null },
  ]);
});
