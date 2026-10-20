import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { config } from '../../src/config.js';
import { runCostBreakdown } from '../../src/cost.js';
import { artifacts, runs } from '../../src/db/schema.js';
import { closeLinearClient } from '../../src/external/linear.js';
import {
  createdTickets,
  gradeRun,
  readRunGrades,
  ticketsContent,
} from '../../src/grading/index.js';
import { RunGrades } from '../../src/grading/schema.js';
import { ingestFile } from '../../src/ingest/ingest.js';
import { models } from '../../src/llm/client.js';
import { loadTask, syncTasks, withRubric } from '../../src/tasks/loader.js';
import { unpackRunFixture } from '../helpers/run-fixture.js';
import { openTestDb } from '../stages/db.js';
import { insertRun, insertVariant } from './seed.js';

// 计算器 run r-20261009-dqva52 写出的真实 feature 文档（vault 中的副本）作为产物；plan 不写入，作为缺失产物
const featureDir = fileURLToPath(
  new URL('../fixtures/vault/Project Magi Eval/Features/r-20261009-dqva52/', import.meta.url),
);
const outDir = path.join(config.repoRoot, '.work/grading');

const { db, close } = openTestDb();
syncTasks(db, config.tasksDir);
insertVariant(db, 'baseline');
const task = withRubric(loadTask(db, 'lfg-calculator'));

// dqva52 于 2026-10-09 开始；Tickets.md 中引用的旧工单不算该 run 建出的
const startedAt = new Date('2026-10-09T00:00:00Z');

function seedLfgRun(id: string) {
  insertRun(db, { id, taskId: task.id, variantId: 'baseline', startedAt });
  for (const [kind, file] of [
    ['brief', 'Brief.md'],
    ['research', 'Research.md'],
    ['tickets', 'Tickets.md'],
  ] as const) {
    const location = path.join(featureDir, file);
    db.insert(artifacts)
      .values({ runId: id, kind, location, snapshot: fs.readFileSync(location, 'utf8') })
      .run();
  }
}

afterAll(async () => {
  await closeLinearClient();
  close();
});

describe('lfg rubric judge（真实 vault 文档、真实 judge 调用）', { timeout: 10 * 60_000 }, () => {
  // W15 Medium 15：以前取 Tickets.md 中提到、run 开始之后创建的工单。r-20261009-dqva52 的 Tickets.md 提到
  // 同一时段由其他 ic run 建出的 TXE-3764、TXE-3767，这两张会被误算进来
  it('tickets 产物附上该 run 的 session 中 save_issue 新建的工单（不含修改已有工单与其他 run 的工单）', async () => {
    const sessionId = '0188c133-3e7b-4592-a963-fc717cf283de';
    const jsonl = unpackRunFixture(
      'r-20261009-dqva52',
      sessionId,
      path.join(outDir, 'tickets-session', randomUUID()),
    );
    ingestFile(db, jsonl);
    insertRun(db, { id: 'w9-lfg-tickets', taskId: task.id, variantId: 'baseline', startedAt });
    db.update(runs).set({ sessionId }).where(eq(runs.id, 'w9-lfg-tickets')).run();
    const run = db.select().from(runs).where(eq(runs.id, 'w9-lfg-tickets')).get();
    if (run === undefined) throw new Error('run 未写入');
    const created = [3776, 3777, 3778, 3780, 3781, 3782, 3783, 3784, 3785].map(
      (n) => `TXE-${String(n)}`,
    );
    expect(createdTickets(db, run)).toEqual(created);
    const snapshot = '# Tickets\n\nTXE-3764 TXE-3767 TXE-3776\n';
    const content = await ticketsContent(db, run, snapshot);
    const attached = [...content.matchAll(/^## (TXE-\d+) /gm)].map((m) => m[1]);
    console.log(`附上的工单：${attached.join(', ')}`);
    expect(attached).toEqual(created);
    expect(content.startsWith(snapshot)).toBe(true);
    expect(content).toContain('# Linear 中该 run 建出的工单');
  });

  it('同一输入评两次：输出完整、分数在范围内，缺失产物记 0 分；差异写入 .work/grading', async () => {
    seedLfgRun('w9-lfg-a');
    seedLfgRun('w9-lfg-b');
    const never = new AbortController().signal;
    await Promise.all([gradeRun(db, 'w9-lfg-a', never), gradeRun(db, 'w9-lfg-b', never)]);
    const results = ['w9-lfg-a', 'w9-lfg-b'].map((id) => {
      const g = readRunGrades(db, id);
      if (g?.rubric == null) throw new Error(`run ${id} 没有 rubric 评分`);
      return { id, grades: g, lfg: g.rubric };
    });

    for (const { id, grades, lfg } of results) {
      expect(RunGrades.parse(grades)).toEqual(grades);
      expect(lfg.artifacts.map((a) => a.artifact)).toEqual([
        'brief',
        'research',
        'plan',
        'tickets',
      ]);
      for (const group of lfg.artifacts) {
        const rubric = task.rubric.find((r) => r.artifact === group.artifact);
        expect(group.items.map((i) => i.itemId)).toEqual(rubric?.items.map((i) => i.id));
        for (const item of group.items) {
          expect(Number.isInteger(item.score)).toBe(true);
          expect(item.score).toBeGreaterThanOrEqual(0);
          expect(item.score).toBeLessThanOrEqual(item.maxScore);
          expect(item.reasoning.length).toBeGreaterThan(0);
        }
      }
      const plan = lfg.artifacts.find((a) => a.artifact === 'plan');
      expect(plan).toMatchObject({ present: false, judgeModel: null, costUsd: 0, score: 0 });
      expect(plan?.items.every((i) => i.score === 0 && i.reasoning.includes('不存在'))).toBe(true);
      for (const a of lfg.artifacts.filter((x) => x.artifact !== 'plan')) {
        expect(a).toMatchObject({ present: true, judgeModel: models.judge });
        expect(a.costUsd).toBeGreaterThan(0);
        expect(a.inputTokens).toBeGreaterThan(0);
      }
      expect(lfg.maxScore).toBe(
        task.rubric.flatMap((g) => g.items).reduce((n, i) => n + i.maxScore, 0),
      );
      expect(grades.costUsd).toBeCloseTo(
        lfg.artifacts.reduce((n, a) => n + a.costUsd, 0),
        10,
      );
      // grading 由 SQL 对各组花费求和，与 grades.costUsd 的累加顺序不同，只比较到 10 位
      expect(runCostBreakdown(db, id)).toEqual({
        agent: 0,
        simulatedUser: 0,
        grading: expect.closeTo(grades.costUsd, 10) as number,
        total: expect.closeTo(grades.costUsd, 10) as number,
      });
    }

    const [a, b] = results;
    if (a === undefined || b === undefined) throw new Error('缺少评分结果');
    const diffs = a.lfg.artifacts.flatMap((ga) => {
      const gb = b.lfg.artifacts.find((x) => x.artifact === ga.artifact);
      return ga.items.map((ia) => {
        const ib = gb?.items.find((x) => x.itemId === ia.itemId);
        if (ib === undefined) throw new Error(`第二次评分缺少 ${ia.itemId}`);
        return {
          artifact: ga.artifact,
          itemId: ia.itemId,
          maxScore: ia.maxScore,
          first: ia.score,
          second: ib.score,
          diff: Math.abs(ia.score - ib.score),
          firstReasoning: ia.reasoning,
          secondReasoning: ib.reasoning,
        };
      });
    });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'judge-stability.json'),
      JSON.stringify({ model: models.judge, first: a.grades, second: b.grades, diffs }, null, 2),
    );
    console.log(
      `总分 ${String(a.lfg.score)} / ${String(b.lfg.score)}（满分 ${String(a.lfg.maxScore)}），花费 $${a.grades.costUsd.toFixed(4)} / $${b.grades.costUsd.toFixed(4)}`,
    );
    for (const d of diffs) {
      console.log(
        `${d.itemId} ${String(d.first)} / ${String(d.second)}（满分 ${String(d.maxScore)}）`,
      );
    }
  });

  it('同一个 run 不能评分两次；GET /api/runs/:id/grades 返回按产物分组的结果', async () => {
    await expect(gradeRun(db, 'w9-lfg-a', new AbortController().signal)).rejects.toThrow(
      '已经评分过',
    );
    const app = await buildApp({
      db,
      sseHeartbeatMs: config.sseHeartbeatMs,
      logger: false,
      tasksDir: config.tasksDir,
    });
    const ok = await app.inject({ method: 'GET', url: '/api/runs/w9-lfg-a/grades' });
    expect(ok.statusCode).toBe(200);
    expect(RunGrades.parse(ok.json())).toEqual(readRunGrades(db, 'w9-lfg-a'));
    const notGraded = await app.inject({ method: 'GET', url: '/api/runs/w9-lfg-tickets/grades' });
    expect(notGraded.statusCode).toBe(404);
    const missing = await app.inject({ method: 'GET', url: '/api/runs/nope/grades' });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
