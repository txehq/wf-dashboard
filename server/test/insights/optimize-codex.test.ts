import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { bindLiveSession } from '../../src/bindings/index.js';
import { config } from '../../src/config.js';
import { openDatabase } from '../../src/db/index.js';
import { analyses } from '../../src/db/schema.js';
import { copyDraftSource, draftLayout, writeDraftDocs } from '../../src/drafts/dir.js';
import { createDrafts } from '../../src/drafts/index.js';
import { ingestFile } from '../../src/ingest/ingest.js';
import { ensureAnalysisBaseline } from '../../src/insights/baseline.js';
import { analysisLayout, newAnalysisId } from '../../src/insights/index.js';
import { rolloutFiles } from '../../src/live/codex.js';
import { createLive } from '../../src/live/index.js';
import { createSettingsStore } from '../../src/runs/settings.js';
import { createVariants } from '../../src/variants/index.js';
import { createWorkflows, loadWorkflow } from '../../src/workflows/index.js';
import { testCodex } from '../helpers/codex.js';
import { testRepos } from '../helpers/local-repos.js';

// 真实档（Contracts 19.3、17.5）：交给 Codex 优化的会话启动，工作目录是分析目录，按一句提示在 optimize/src/ 中写一行。
// 一次 Codex 调用：优化草稿的 optimize/ 与 PLATFORM.md 由准备的前两步写出（不装 skill、不发报告的初始消息），
// Codex 的项换成一句话的提示，不跑完整的优化。记录耗时与 token
const dbFile = path.join(config.repoRoot, '.work', 'test-db', `${randomUUID()}.sqlite`);
const db = openDatabase(dbFile, config.migrationsDir);
const variants = createVariants({
  db,
  dataDir: config.dataDir,
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
});
const live = createLive({
  db,
  variants,
  settings: createSettingsStore(db),
  vaultDir: config.vaultDir,
  product: config.evalProduct,
  liveDir: config.liveDir,
  dataDir: config.dataDir,
  serverUrl: () => 'http://127.0.0.1:1',
  localHome: path.join(config.dataDir, 'home'),
  repos: testRepos(),
  codex: { ...testCodex('codex'), sessionTimeoutMs: 120_000 },
  claudeBin: config.claudeBin,
});
const drafts = createDrafts({
  db,
  variants,
  live,
  draftsDir: config.workflowDraftsDir,
  dataDir: config.dataDir,
  skillSources: config.codexSkillSources,
});

afterAll(async () => {
  await live.shutdown();
  db.$client.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
  fs.rmSync(analysisLayout(config.dataDir, analysisId).dir, { recursive: true, force: true });
});

const TokenCount = z.looseObject({
  type: z.literal('event_msg'),
  payload: z.looseObject({
    type: z.literal('token_count'),
    info: z.looseObject({ total_token_usage: z.record(z.string(), z.number()) }).nullable(),
  }),
});

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

// 被分析的 variant 与一次成功的分析（测试数据）
const SESSION = 'cfa31f10-e280-4908-bcf7-cbe9b00fbe53';
const sessionFile = path.join(config.dataDir, 'sessions', `${SESSION}.jsonl`);
fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
fs.copyFileSync(
  path.join(config.repoRoot, 'server/test/fixtures/live', `${SESSION}.jsonl`),
  sessionFile,
);
ingestFile(db, sessionFile);
const flowId = `w45-codex-${randomUUID().slice(0, 6)}`;
createWorkflows({ db, variants }).create({
  id: flowId,
  name: flowId,
  description: '',
  definition: { id: flowId, name: flowId, stages: [{ id: 'remember' }] },
});
const analysed = variants.list().find((v) => v.workflowId === flowId);
if (analysed === undefined) throw new Error(`workflow ${flowId} 没有建出初稿`);
await variants.build(analysed.id);
bindLiveSession(db, config.dataDir, SESSION, analysed.id);
const baseline = await ensureAnalysisBaseline(db, variants);
const analysisId = newAnalysisId();
db.insert(analyses)
  .values({
    id: analysisId,
    engine: 'claude',
    model: 'claude-opus-5-5',
    variantId: analysed.id,
    analysisVariantId: baseline.id,
    sessionIds: [SESSION],
    status: 'succeeded',
    steps: [],
    report: {
      summary: '测试',
      goal: '测试',
      outcome: 'achieved',
      topIssues: [],
      workflowChanges: [],
    },
  })
  .run();
fs.mkdirSync(analysisLayout(config.dataDir, analysisId).dir, { recursive: true });

describe('交给 Codex 优化的会话（真实 Codex，一次）', { timeout: 600_000 }, () => {
  test('在分析目录中启动交互的 codex，按一句提示在 optimize/src/ 中写一行，然后结束', async () => {
    const { draft } = drafts.openOptimize(analysisId);
    const layout = draftLayout(draft.dir, 'optimize');
    await copyDraftSource(layout, (dest) => variants.exportSource(analysed.id, dest));
    writeDraftDocs(layout, 'optimize', loadWorkflow(db, flowId));
    const file = path.join(layout.skills, 'remember/SKILL.md');
    const started = Date.now();
    const item = live.createCodexItem({
      cwd: draft.dir,
      prompt: '在 optimize/src/skills/remember/SKILL.md 末尾加一行 ok',
      title: 'W45 真实 Codex 优化',
      workflow: null,
      purpose: 'optimize',
    });
    const detail = await live.startCodex(item.id);
    expect(detail.status).toBe('running');
    expect(detail.cwd).toBe(analysisLayout(config.dataDir, analysisId).dir);
    let lines: string[] = [];
    while (Date.now() - started < 300_000) {
      lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
      if (lines.at(-1)?.trim() === 'ok') break;
      await sleep(1000);
    }
    const seconds = (Date.now() - started) / 1000;
    expect(lines.at(-1)?.trim()).toBe('ok');
    await sleep(5000);
    expect((await live.stop(detail.id)).status).toBe('exited');
    const [rollout] = rolloutFiles(path.join(draft.dir, 'codex-home'));
    if (rollout === undefined) throw new Error('没有 rollout');
    const usage = fs
      .readFileSync(rollout, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => TokenCount.safeParse(JSON.parse(l)))
      .flatMap((r) => (r.success && r.data.payload.info !== null ? [r.data.payload.info] : []))
      .at(-1)?.total_token_usage;
    console.info(
      `[W45 真实 Codex 优化] 写入 ok 用时 ${String(seconds)} 秒；token ${JSON.stringify(usage ?? null)}`,
    );
  });
});
