import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import { openDatabase } from '../../src/db/index.js';
import { liveProcesses, liveSessions } from '../../src/db/schema.js';
import { type AppEvent, events } from '../../src/events.js';
import { createLive } from '../../src/live/index.js';
import { createSettingsStore } from '../../src/runs/settings.js';
import { createVariants } from '../../src/variants/index.js';
import { testRepos } from '../helpers/local-repos.js';

const dbFile = path.join(config.repoRoot, '.work', 'test-db', `${randomUUID()}.sqlite`);
const db = openDatabase(dbFile, config.migrationsDir);

afterAll(() => {
  db.$client.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
});

// Contracts 14.1：PTY 进程是服务的子进程，随服务退出；服务启动时 running 的进程一律改为 exited
test('服务重启：running 的进程变为 exited，error 为"服务重启中断"', () => {
  const item = {
    environment: 'real' as const,
    workflow: 'lfg' as const,
    input: '做一个计算器',
    title: '/lfg 做一个计算器',
    cwd: config.repoRoot,
    updatedAt: new Date(),
  };
  db.insert(liveSessions)
    .values([
      { ...item, id: 'l-20261012-run001', claudeSessionId: randomUUID() },
      { ...item, id: 'l-20261012-exit01', claudeSessionId: randomUUID() },
    ])
    .run();
  const process = { variantId: null, driver: 'human' as const, startedAt: new Date() };
  const [first, running, exited] = db
    .insert(liveProcesses)
    .values([
      // 同一项先退出了一个进程，resume 出来的进程还在运行
      { ...process, liveId: 'l-20261012-run001', kind: 'start', status: 'exited', exitCode: 0 },
      { ...process, liveId: 'l-20261012-run001', kind: 'resume', status: 'running', pid: 99999 },
      { ...process, liveId: 'l-20261012-exit01', kind: 'start', status: 'exited', exitCode: 0 },
    ])
    .returning({ id: liveProcesses.id })
    .all();
  if (first === undefined || running === undefined || exited === undefined) {
    throw new Error('进程没有写入');
  }
  const published: AppEvent[] = [];
  const unsubscribe = events.subscribe((e) => published.push(e));
  createLive({
    db,
    variants: createVariants({
      db,
      dataDir: config.dataDir,
      repo: config.txeWorkflowRepo,
      ctxBin: config.ctxBin,
    }),
    settings: createSettingsStore(db),
    vaultDir: config.vaultDir,
    product: config.evalProduct,
    liveDir: config.liveDir,
    dataDir: config.dataDir,
    serverUrl: () => 'http://127.0.0.1:1',
    localHome: path.join(config.dataDir, 'home'),
    repos: testRepos(),
  });
  unsubscribe();
  const byId = (id: number) =>
    db.select().from(liveProcesses).where(eq(liveProcesses.id, id)).get();
  const interrupted = byId(running.id);
  expect(interrupted?.status).toBe('exited');
  expect(interrupted?.error).toBe('服务重启中断');
  expect(interrupted?.endedAt).not.toBeNull();
  for (const untouched of [byId(first.id), byId(exited.id)]) {
    expect(untouched?.error).toBeNull();
    expect(untouched?.exitCode).toBe(0);
  }
  expect(published).toEqual([{ type: 'live.updated', liveId: 'l-20261012-run001' }]);
});
