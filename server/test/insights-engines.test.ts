import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { bindLiveSession } from '../src/bindings/index.js';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { ingestFile } from '../src/ingest/ingest.js';
import { ensureAnalysisBaseline } from '../src/insights/baseline.js';
import { createInsights } from '../src/insights/index.js';
import { createVariants } from '../src/variants/index.js';
import { createWorkflows, loadWorkflow } from '../src/workflows/index.js';
import { sourceDirsOf, workDir } from './helpers/session-fixtures.js';

// 真实档（Contracts 19.2）：Claude Code 引擎用 session-analysis 的基线 variant 分析最简单的 session——一轮的
// "请记住暗号"（cfa31f10）。要证明的是每个阶段由 variant 的 skill 驱动、全部方面通过证据校验、report.json 通过校验，
// 不追求发现的质量。每个阶段的耗时、token 与花费写到 .work/w45/，供报告引用
const dir = workDir('insights-engines');
const dataDir = path.join(dir, 'data');
const db = openDatabase(path.join(dir, 'db.sqlite'), config.migrationsDir);
const variants = createVariants({
  db,
  dataDir,
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
});
const insights = createInsights({ db, variants, dataDir, dirs: sourceDirsOf(dataDir) });
const records = path.join(config.repoRoot, '.work', 'w45');
fs.mkdirSync(records, { recursive: true });

afterAll(async () => {
  await insights.shutdown();
  db.$client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const SESSION = 'cfa31f10-e280-4908-bcf7-cbe9b00fbe53';
const baseline = await ensureAnalysisBaseline(db, variants);
// 被分析的 variant：从空白新建的一个 workflow 的初稿，session 放在它的配置目录中，作为它在 Live 中的 session 绑定
const marker = randomUUID().slice(0, 6);
const flowId = `w45-real-${marker}`;
createWorkflows({ db, variants }).create({
  id: flowId,
  name: `W45 真实档 ${marker}`,
  description: '',
  definition: { id: flowId, name: `W45 真实档 ${marker}`, stages: [{ id: `answer-${marker}` }] },
});
const analysed = variants.list().find((v) => v.workflowId === flowId);
if (analysed === undefined) throw new Error(`workflow ${flowId} 没有建出初稿`);
await variants.build(analysed.id);
const sessionFile = path.join(
  variants.layout(analysed.id).claudeDir,
  'projects',
  '-fixture-w45',
  `${SESSION}.jsonl`,
);
fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
fs.copyFileSync(
  path.join(config.repoRoot, 'server/test/fixtures/live', `${SESSION}.jsonl`),
  sessionFile,
);
ingestFile(db, sessionFile);
bindLiveSession(db, dataDir, SESSION, analysed.id);

describe('真实引擎按 session-analysis 的 skill 分析', { timeout: 40 * 60_000 }, () => {
  test('Claude Code（models.judge）用基线分析 cfa31f10：九个方面与 synthesize 都成功，发现通过证据校验，report.json 通过校验', async () => {
    const created = await insights.create({ sessionIds: [SESSION], engine: 'claude' });
    const done = await insights.settled(created.id);
    const detail = insights.detail(created.id);
    const stages = loadWorkflow(db, 'session-analysis').stages.map((s) => s.id);
    const summary = {
      id: created.id,
      model: done.model,
      analysisVariant: baseline.id,
      status: done.status,
      error: done.error,
      costUsd: done.costUsd,
      findings: Object.fromEntries(
        stages.slice(0, -1).map((a) => [a, detail.findings.filter((f) => f.aspect === a).length]),
      ),
      patches: detail.patches.length,
      report: detail.report,
      steps: done.steps.map((s) => ({
        key: s.key,
        status: s.status,
        seconds:
          s.startedAt === null || s.endedAt === null ? null : (s.endedAt - s.startedAt) / 1000,
        tokens: s.tokens,
        costUsd: s.costUsd,
        error: s.error,
      })),
    };
    fs.writeFileSync(path.join(records, 'engines-claude.json'), JSON.stringify(summary, null, 2));
    expect(done.error).toBeNull();
    expect(done.status).toBe('succeeded');
    expect(done.analysisVariantId).toBe(baseline.id);
    expect(done.steps.map((s) => s.key)).toEqual(stages);
    expect(done.steps.every((s) => s.status === 'succeeded' && (s.costUsd ?? 0) > 0)).toBe(true);
    expect(detail.report).not.toBeNull();
    // 每个阶段的进程都调用了入口 skill 与那个阶段的 skill（引擎记录在 logs/<阶段>.log）
    const logs = path.join(dataDir, 'analyses', created.id, 'logs');
    for (const stage of stages) {
      const log = fs.readFileSync(path.join(logs, `${stage}.log`), 'utf8');
      expect(log, stage).toContain(`"skill":"${stage}"`);
    }
  });
});
