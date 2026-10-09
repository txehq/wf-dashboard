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
import { gradeRun, readRunGrades, ticketsContent } from '../../src/grading/index.js';
import { RunGrades } from '../../src/grading/schema.js';
import { models } from '../../src/llm/client.js';
import { loadLfgTask, syncTasks } from '../../src/tasks/loader.js';
import { openTestDb } from '../stages/db.js';
import { insertRun, insertVariant } from './seed.js';

// 真实的 feature 文档（只读）作为产物；plan 没有锁定，作为缺失产物
const featureDir =
  '/Users/linhaoz/Documents/Obsidian Vault/Project Magi/Features/optional-mcp-install';
const tasksDir = fileURLToPath(new URL('../fixtures/lfg-tasks/', import.meta.url));
const outDir = path.join(config.repoRoot, '.work/grading');

const { db, close } = openTestDb();
syncTasks(db, tasksDir);
insertVariant(db, 'baseline');
const task = loadLfgTask(db, 'optional-mcp-install');

// Tickets.md 写于 2026-09-18；run 从当天 00:00 开始，引用的旧工单不算该 run 建出的
const startedAt = new Date('2026-09-18T00:00:00Z');

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
  it('tickets 产物附上 Tickets.md 中引用、在 run 开始之后创建的 Linear 工单', async () => {
    seedLfgRun('w9-lfg-tickets');
    const run = db.select().from(runs).where(eq(runs.id, 'w9-lfg-tickets')).get();
    if (run === undefined) throw new Error('run 未写入');
    const snapshot = fs.readFileSync(path.join(featureDir, 'Tickets.md'), 'utf8');
    const content = await ticketsContent(run, snapshot);
    const attached = [...content.matchAll(/^## (TXE-\d+) /gm)].map((m) => m[1]);
    console.log(`附上的工单：${attached.join(', ')}`);
    expect(attached).toEqual(['TXE-2105', 'TXE-2106', 'TXE-2107']);
    expect(content.startsWith(snapshot)).toBe(true);
    expect(content).toContain('# Linear 中该 run 建出的工单');
  });

  it('同一输入评两次：输出完整、分数在范围内，缺失产物记 0 分；差异写入 .work/grading', async () => {
    seedLfgRun('w9-lfg-a');
    seedLfgRun('w9-lfg-b');
    await Promise.all([gradeRun(db, 'w9-lfg-a'), gradeRun(db, 'w9-lfg-b')]);
    const results = ['w9-lfg-a', 'w9-lfg-b'].map((id) => {
      const g = readRunGrades(db, id);
      if (g?.lfg == null) throw new Error(`run ${id} 没有 lfg 评分`);
      return { id, grades: g, lfg: g.lfg };
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
      expect(runCostBreakdown(db, id)).toEqual({
        agent: 0,
        simulatedUser: 0,
        stageCheck: 0,
        grading: grades.costUsd,
        total: grades.costUsd,
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
    await expect(gradeRun(db, 'w9-lfg-a')).rejects.toThrow('已经评分过');
    const app = await buildApp({
      db,
      sseHeartbeatMs: config.sseHeartbeatMs,
      logger: false,
      tasksDir,
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
