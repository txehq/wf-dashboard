import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { afterAll, describe, expect, test } from 'vitest';
import { rebindAll } from '../src/bindings/index.js';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { ingestFile } from '../src/ingest/ingest.js';
import { createInsights, type Insights } from '../src/insights/index.js';
import { syncTasks } from '../src/tasks/loader.js';
import { createVariants } from '../src/variants/index.js';
import {
  BASE_COMMIT,
  copyOtherIcSession,
  IC,
  IC_OTHER,
  unpackSession,
  workDir,
} from './helpers/session-fixtures.js';

// Contracts 15.2：真实引擎分析真实 session，不 mock。用最短的 session：27yz3d（ic，34 个主请求）；
// 两个 session 一起分析时另加 40f6915a（ic，同一个基线）。
// 每次分析的步骤、耗时、token 与花费写到 .work/w31/，供报告对比两种引擎
const dir = workDir('insights-engines');
const dataDir = path.join(dir, 'data');
const db = openDatabase(path.join(dir, 'db.sqlite'), config.migrationsDir);
syncTasks(db, config.tasksDir);
const variants = createVariants({
  db,
  dataDir,
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
  onSkillsChanged: () => {
    rebindAll(db, dataDir);
  },
});
const insights: Insights = createInsights({ db, variants, dataDir });
const records = path.join(config.repoRoot, '.work', 'w31');
fs.mkdirSync(records, { recursive: true });

afterAll(async () => {
  await insights.shutdown();
  db.$client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

ingestFile(db, unpackSession(dir, IC));
ingestFile(db, copyOtherIcSession(dir));
const variant = await variants.createBaseline({
  name: 'w31-engines',
  commit: BASE_COMMIT,
});

async function analyze(name: string, engine: 'claude' | 'codex', sessionIds: string[]) {
  const created = insights.create({ sessionIds, engine });
  const done = await insights.settled(created.id);
  const detail = insights.detail(created.id);
  const summary = {
    id: created.id,
    engine,
    model: done.model,
    sessions: sessionIds,
    status: done.status,
    error: done.error,
    costUsd: done.costUsd,
    findings: Object.fromEntries(
      ['process', 'efficiency', 'interaction', 'quality'].map((a) => [
        a,
        detail.findings.filter((f) => f.aspect === a).length,
      ]),
    ),
    patches: detail.patches.length,
    files: detail.files.map((f) => ({ path: f.path, hunks: f.hunks.length })),
    steps: done.steps.map((s) => ({
      key: s.key,
      status: s.status,
      seconds: s.startedAt === null || s.endedAt === null ? null : (s.endedAt - s.startedAt) / 1000,
      tokens: s.tokens,
      costUsd: s.costUsd,
      events: s.events,
    })),
    detail,
  };
  fs.writeFileSync(path.join(records, `${name}.json`), JSON.stringify(summary, null, 2));
  expect(done.error).toBeNull();
  expect(done.status).toBe('succeeded');
  return summary;
}

// 修改建议在 input/skills 的副本上真实应用
async function applies(analysisId: string, patch: string, file: string) {
  const work = path.join(dir, 'apply', analysisId, file.replaceAll('/', '_'));
  fs.cpSync(path.join(dataDir, 'analyses', analysisId, 'input', 'skills'), work, {
    recursive: true,
  });
  const patchFile = `${work}.diff`;
  fs.writeFileSync(patchFile, patch.endsWith('\n') ? patch : `${patch}\n`);
  const result = await execa('git', ['apply', '--check', '-p1', patchFile], {
    cwd: work,
    reject: false,
    env: { GIT_CEILING_DIRECTORIES: path.dirname(work) },
  });
  return result.exitCode === 0;
}

describe('真实引擎分析真实 session', { timeout: 50 * 60_000 }, () => {
  test('Claude Code（models.judge）分析 27yz3d：四个方面都通过证据校验，至少一个 patch 能应用', async () => {
    const s = await analyze('claude-ic', 'claude', [IC.sessionId]);
    expect(s.model).toBe(insights.defaults().claude);
    expect(s.steps.every((x) => x.status === 'succeeded' && (x.costUsd ?? 0) > 0)).toBe(true);
    expect(s.costUsd).toBeGreaterThan(0);
    expect(s.patches).toBeGreaterThan(0);
    const [first] = s.detail.patches;
    if (first === undefined) throw new Error('没有 patch');
    expect(await applies(s.id, first.patch, first.file)).toBe(true);
    for (const f of s.detail.findings) {
      expect(f.evidence.every((e) => e.sessionId === IC.sessionId)).toBe(true);
    }
  });

  test('Codex（~/.codex/config.toml 的 model）分析同一个 session：结果同样通过校验，只记 token', async () => {
    const s = await analyze('codex-ic', 'codex', [IC.sessionId]);
    expect(s.model).toBe(insights.defaults().codex);
    expect(s.costUsd).toBeNull();
    expect(s.steps.every((x) => x.status === 'succeeded' && x.tokens.output > 0)).toBe(true);
    expect(s.patches).toBeGreaterThan(0);
    const [first] = s.detail.patches;
    if (first === undefined) throw new Error('没有 patch');
    expect(await applies(s.id, first.patch, first.file)).toBe(true);
  });

  test('同一 variant 的两个 session 一起分析：发现中的证据来自两个 session', async () => {
    const s = await analyze('claude-both', 'claude', [IC.sessionId, IC_OTHER.sessionId]);
    const cited = new Set(s.detail.findings.flatMap((f) => f.evidence.map((e) => e.sessionId)));
    expect([...cited].sort()).toEqual([IC.sessionId, IC_OTHER.sessionId].sort());
  });

  test('取消：停掉全部引擎进程，状态为已取消', async () => {
    const created = insights.create({ sessionIds: [IC.sessionId], engine: 'claude' });
    // 等到四个方面都已启动
    for (;;) {
      const row = insights.get(created.id);
      if (row.steps.filter((s) => s.status === 'running').length === 4) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    insights.cancel(created.id);
    const done = await insights.settled(created.id);
    expect(done.status).toBe('cancelled');
    expect(done.error).toBeNull();
    expect(done.steps.map((s) => s.status)).toEqual([
      'cancelled',
      'cancelled',
      'cancelled',
      'cancelled',
      'cancelled',
    ]);
    // 引擎进程都已结束：分析目录不再被写入
    const logs = path.join(dataDir, 'analyses', created.id, 'logs');
    const size = () =>
      fs.readdirSync(logs).reduce((sum, f) => sum + fs.statSync(path.join(logs, f)).size, 0);
    const before = size();
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect(size()).toBe(before);
  });

  test('所选 session 没有绑定同一个 variant 时拒绝', () => {
    variants.derive(variant.id, { name: 'w31-engines-other' });
    const other = variants.list().find((v) => v.name === 'w31-engines-other');
    if (other === undefined) throw new Error('没有派生出 variant');
    variants.writeFile(other.id, 'skills/ic/NOTE.md', 'x\n');
    db.$client
      .prepare("update sessions set variant_id = ?, variant_binding = 'manual' where id = ?")
      .run(other.id, IC_OTHER.sessionId);
    expect(() =>
      insights.create({ sessionIds: [IC.sessionId, IC_OTHER.sessionId], engine: 'claude' }),
    ).toThrow('所选 session 必须都绑定到同一个 variant');
  });
});
