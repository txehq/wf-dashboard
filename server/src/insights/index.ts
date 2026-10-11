import { randomInt, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from '@decimalturn/toml-patch';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import {
  type AnalysisAspect,
  analysisAspects,
  type AnalysisEngine,
  analyses,
  analysisFindings,
  analysisPatches,
  type AnalysisStep,
  type AnalysisStepKey,
  analysisStepKeys,
  runs,
  sessions,
  userMessages,
  type VariantBinding,
  variants as variantsTable,
} from '../db/schema.js';
import { sessionTitle } from '../api/user-text.js';
import { events } from '../events.js';
import { claudeSettingsEnv, models } from '../llm/client.js';
import { writeCodexHome } from '../variants/codex-home.js';
import { HttpError } from '../variants/errors.js';
import type { Variants } from '../variants/index.js';
import { runEngine } from './engines.js';
import { writeInput } from './export.js';
import { aspectPrompt, synthesisPrompt } from './prompts.js';
import { analysisSandboxProfile } from './sandbox.js';
import {
  evidenceIndex,
  type FileProposal,
  findingsFile,
  validateFindings,
  validatePatches,
  type ValidatedFinding,
  writeFindingsWithIds,
} from './validate.js';

// Contracts 15.2、15.3：分析 session、修改建议另存为 variant

export type Analysis = typeof analyses.$inferSelect;
type Variant = typeof variantsTable.$inferSelect;

export interface InsightsOptions {
  db: Db;
  variants: Variants;
  dataDir: string;
  claudeSettingsPath?: string | undefined;
  codexAuthPath?: string | undefined;
  codexConfigPath?: string | undefined;
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

// 取消时中止的原因；与引擎失败、校验失败区分
const CANCELLED = new Error('分析已取消');

// a-<yyyymmdd>-<6 位小写字母数字>
export function newAnalysisId(now = new Date()): string {
  const day = now.toISOString().slice(0, 10).replaceAll('-', '');
  const suffix = Array.from({ length: 6 }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join(
    '',
  );
  return `a-${day}-${suffix}`;
}

const CodexConfig = z.looseObject({ model: z.string().min(1) });

// Codex 的默认模型：~/.codex/config.toml 的 model
export function codexDefaultModel(configPath: string = config.codexConfigPath): string {
  return CodexConfig.parse(parse(fs.readFileSync(configPath, 'utf8'))).model;
}

const pendingStep = (key: AnalysisStepKey): AnalysisStep => ({
  key,
  status: 'pending',
  startedAt: null,
  endedAt: null,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  costUsd: null,
  events: 0,
  error: null,
});

export interface ScopeSession {
  id: string;
  title: string | null;
  startedAt: string;
  runId: string | null;
  variant: { id: string; name: string } | null;
  binding: VariantBinding | null;
}

export interface Scope {
  sessions: ScopeSession[];
  variant: { id: string; name: string } | null;
  // 不能分析的原因；为空时可以分析
  problem: string | null;
}

export interface AnalysisDetail extends Analysis {
  variantName: string;
  sessions: ScopeSession[];
  findings: (typeof analysisFindings.$inferSelect)[];
  patches: (typeof analysisPatches.$inferSelect)[];
  files: FileProposal[];
}

const layoutOf = (dataDir: string, id: string) => {
  const dir = path.join(dataDir, 'analyses', id);
  return {
    dir,
    input: path.join(dir, 'input'),
    output: path.join(dir, 'output'),
    logs: path.join(dir, 'logs'),
    check: path.join(dir, 'check'),
    proposals: path.join(dir, 'proposals.json'),
  };
};

export function createInsights({
  db,
  variants,
  dataDir,
  claudeSettingsPath = config.claudeSettingsPath,
  codexAuthPath = config.codexAuthPath,
  codexConfigPath = config.codexConfigPath,
}: InsightsOptions) {
  const controllers = new Map<string, AbortController>();
  const homes = {
    claude: path.join(dataDir, 'analysis-home', 'claude'),
    codex: path.join(dataDir, 'analysis-home', 'codex'),
  };

  // 上次服务退出时仍在进行的分析不会再完成
  for (const row of db
    .select({ id: analyses.id, steps: analyses.steps })
    .from(analyses)
    .where(inArray(analyses.status, ['queued', 'running']))
    .all()) {
    db.update(analyses)
      .set({
        status: 'failed',
        error: '服务重启中断',
        endedAt: new Date(),
        steps: row.steps.map((s) =>
          s.status === 'running' || s.status === 'pending' ? { ...s, status: 'cancelled' } : s,
        ),
      })
      .where(eq(analyses.id, row.id))
      .run();
  }

  function get(id: string): Analysis {
    const row = db.select().from(analyses).where(eq(analyses.id, id)).get();
    if (row === undefined) throw new HttpError(404, `分析不存在：${id}`);
    return row;
  }

  function publish(id: string) {
    events.publish({ type: 'analysis.updated', analysisId: id, status: get(id).status });
  }

  function update(id: string, values: Partial<typeof analyses.$inferInsert>) {
    db.update(analyses).set(values).where(eq(analyses.id, id)).run();
    publish(id);
  }

  // 步骤状态写回 steps；事件计数的更新每个步骤每 2 秒最多写一次
  const lastEventWrite = new Map<string, number>();
  function updateStep(id: string, key: AnalysisStepKey, change: Partial<AnalysisStep>) {
    const row = get(id);
    const steps = row.steps.map((s) => (s.key === key ? { ...s, ...change } : s));
    const cost = steps.some((s) => s.costUsd !== null)
      ? steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0)
      : null;
    update(id, { steps, costUsd: cost });
  }
  function countEvent(id: string, key: AnalysisStepKey) {
    const row = get(id);
    const step = row.steps.find((s) => s.key === key);
    if (step === undefined) throw new Error(`分析 ${id} 没有步骤 ${key}`);
    const mark = `${id}:${key}`;
    const now = Date.now();
    const count = step.events + 1;
    if (now - (lastEventWrite.get(mark) ?? 0) < 2_000) {
      db.update(analyses)
        .set({ steps: row.steps.map((s) => (s.key === key ? { ...s, events: count } : s)) })
        .where(eq(analyses.id, id))
        .run();
      return;
    }
    lastEventWrite.set(mark, now);
    updateStep(id, key, { events: count });
  }

  function variantName(variantId: string): string {
    const v = db
      .select({ name: variantsTable.name })
      .from(variantsTable)
      .where(eq(variantsTable.id, variantId))
      .get();
    if (v === undefined) throw new Error(`variant 不存在：${variantId}`);
    return v.name;
  }

  function scopeSessions(sessionIds: string[]): ScopeSession[] {
    const rows = db
      .select({
        id: sessions.id,
        startedAt: sessions.startedAt,
        runId: sessions.runId,
        variantId: sessions.variantId,
        binding: sessions.variantBinding,
      })
      .from(sessions)
      .where(inArray(sessions.id, sessionIds))
      .all();
    // 标题与 Sessions 列表相同：主 session 首条用户消息（slash 命令显示为命令名加参数）
    const titles = new Map(
      db
        .select({
          sessionId: userMessages.sessionId,
          text: userMessages.text,
          first: sql<number>`min(${userMessages.timestamp})`,
        })
        .from(userMessages)
        .where(
          and(
            inArray(userMessages.sessionId, sessionIds),
            isNull(userMessages.agentId),
            eq(userMessages.kind, 'user'),
          ),
        )
        .groupBy(userMessages.sessionId)
        .all()
        .map((m) => [m.sessionId, sessionTitle(m.text)]),
    );
    return sessionIds.map((id) => {
      const r = rows.find((s) => s.id === id);
      if (r === undefined) throw new HttpError(404, `session 不存在：${id}`);
      return {
        id: r.id,
        title: titles.get(r.id) ?? null,
        startedAt: r.startedAt.toISOString(),
        runId: r.runId,
        variant: r.variantId === null ? null : { id: r.variantId, name: variantName(r.variantId) },
        binding: r.binding,
      };
    });
  }

  // 一个 batch 的全部 run 的 session
  function batchSessionIds(batchId: string): string[] {
    const rows = db
      .select({ id: runs.id, sessionId: runs.sessionId })
      .from(runs)
      .where(eq(runs.batchId, batchId))
      .orderBy(asc(runs.createdAt), asc(runs.id))
      .all();
    if (rows.length === 0) throw new HttpError(404, `batch ${batchId} 没有 run`);
    const imported = new Set(
      db
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          inArray(
            sessions.id,
            rows.map((r) => r.sessionId),
          ),
        )
        .all()
        .map((s) => s.id),
    );
    const missing = rows.filter((r) => !imported.has(r.sessionId));
    if (missing.length > 0) {
      throw new HttpError(
        409,
        `这些 run 还没有 session（排队中或没有启动）：${missing.map((r) => r.id).join('、')}`,
      );
    }
    return rows.map((r) => r.sessionId);
  }

  function scope(input: {
    sessionIds?: string[] | undefined;
    batchId?: string | undefined;
  }): Scope {
    const ids =
      input.batchId !== undefined ? batchSessionIds(input.batchId) : (input.sessionIds ?? []);
    if (ids.length === 0) throw new HttpError(400, '没有选择 session');
    if (new Set(ids).size !== ids.length) throw new HttpError(400, 'session 有重复');
    const list = scopeSessions(ids);
    const unbound = list.filter((s) => s.variant === null);
    if (unbound.length > 0) {
      return {
        sessions: list,
        variant: null,
        problem: `这些 session 没有绑定 variant：${unbound.map((s) => s.id.slice(0, 8)).join('、')}`,
      };
    }
    const distinct = [...new Map(list.map((s) => [s.variant?.id, s.variant])).values()];
    if (distinct.length > 1) {
      return {
        sessions: list,
        variant: null,
        problem: `所选 session 必须都绑定到同一个 variant，现在是：${distinct.map((v) => v?.name).join('、')}`,
      };
    }
    return { sessions: list, variant: distinct[0] ?? null, problem: null };
  }

  function prepareHome(engine: AnalysisEngine) {
    if (engine === 'claude') {
      fs.mkdirSync(homes.claude, { recursive: true });
      const home = os.homedir();
      // cwd 在 $HOME 之下时，真实 ~/.claude/CLAUDE.md 会被当作祖先目录的文件读入
      const settings = {
        env: claudeSettingsEnv(claudeSettingsPath),
        claudeMdExcludes: [
          path.join(home, '.claude/CLAUDE.md'),
          path.join(home, '.claude/rules/**'),
        ],
      };
      const file = path.join(homes.claude, 'settings.json');
      const tmp = `${file}.${randomUUID()}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, file);
    } else {
      writeCodexHome(homes.codex, { authPath: codexAuthPath, configPath: codexConfigPath });
    }
  }

  async function runStep(
    row: Analysis,
    key: AnalysisStepKey,
    prompt: string,
    signal: AbortSignal,
  ): Promise<void> {
    const dirs = layoutOf(dataDir, row.id);
    updateStep(row.id, key, { status: 'running', startedAt: Date.now() });
    const engineHome = homes[row.engine];
    const result = await runEngine({
      engine: row.engine,
      model: row.model,
      cwd: dirs.dir,
      prompt,
      engineHome,
      profile: analysisSandboxProfile({
        analysisDir: dirs.dir,
        engineHome,
        repoRoot: config.repoRoot,
        dataDir,
      }),
      logFile: path.join(dirs.logs, `${key}.log`),
      signal,
      onEvent: () => {
        countEvent(row.id, key);
      },
    });
    updateStep(row.id, key, { tokens: result.tokens, costUsd: result.costUsd });
  }

  // 一步完成后的校验也算在这一步里：失败时这一步记为 failed，原文写进 error
  async function step<T>(
    row: Analysis,
    key: AnalysisStepKey,
    prompt: string,
    signal: AbortSignal,
    check: () => T | Promise<T>,
  ): Promise<T> {
    return runStep(row, key, prompt, signal)
      .then(check)
      .then(
        (value) => {
          updateStep(row.id, key, { status: 'succeeded', endedAt: Date.now() });
          return value;
        },
        (error: unknown) => {
          const cancelled = signal.aborted;
          updateStep(row.id, key, {
            status: cancelled ? 'cancelled' : 'failed',
            endedAt: Date.now(),
            error: cancelled ? null : error instanceof Error ? error.message : String(error),
          });
          throw error;
        },
      );
  }

  async function execute(id: string, controller: AbortController) {
    const { signal } = controller;
    const dirs = layoutOf(dataDir, id);
    update(id, { status: 'running' });
    const row = get(id);
    for (const dir of [dirs.output, dirs.logs]) fs.mkdirSync(dir, { recursive: true });
    const exported = await writeInput(db, {
      analysisId: id,
      variant: { id: row.variantId, name: variantName(row.variantId) },
      skillsDir: variants.layout(row.variantId).skills,
      sessionIds: row.sessionIds,
      inputDir: dirs.input,
    });
    signal.throwIfAborted();
    const index = evidenceIndex(exported);
    prepareHome(row.engine);

    const found = await Promise.all(
      analysisAspects.map((aspect: AnalysisAspect) =>
        step(row, aspect, aspectPrompt(aspect), signal, () => {
          const file = path.join(dirs.output, findingsFile(aspect));
          const findings = validateFindings(file, aspect, index);
          writeFindingsWithIds(file, findings);
          return findings;
        }).catch((error: unknown) => {
          // 一个方面失败时停掉其余的引擎进程
          controller.abort(error);
          throw error;
        }),
      ),
    );
    const findings: ValidatedFinding[] = found.flat();
    db.transaction((tx) => {
      for (const f of findings) {
        tx.insert(analysisFindings)
          .values({
            analysisId: id,
            findingId: f.findingId,
            aspect: f.aspect,
            title: f.title,
            stage: f.stage,
            skill: f.skill,
            severity: f.severity,
            detail: f.detail,
            evidence: f.evidence,
          })
          .run();
      }
    });
    publish(id);

    const proposal = await step(row, 'synthesis', synthesisPrompt(), signal, () =>
      validatePatches(
        path.join(dirs.output, 'patches.json'),
        path.join(dirs.input, 'skills'),
        dirs.check,
        new Set(findings.map((f) => f.findingId)),
      ),
    );
    fs.writeFileSync(dirs.proposals, `${JSON.stringify(proposal.files)}\n`);
    db.transaction((tx) => {
      for (const p of proposal.patches) {
        tx.insert(analysisPatches)
          .values({
            analysisId: id,
            file: p.file,
            findingIds: p.findingIds,
            rationale: p.rationale,
            patch: p.patch,
          })
          .run();
      }
    });
    update(id, { status: 'succeeded', endedAt: new Date() });
  }

  function finish(id: string, controller: AbortController, error: unknown) {
    const row = get(id);
    const cancelled = controller.signal.aborted && controller.signal.reason === CANCELLED;
    update(id, {
      status: cancelled ? 'cancelled' : 'failed',
      error: cancelled ? null : error instanceof Error ? error.message : String(error),
      endedAt: new Date(),
      steps: row.steps.map((s) =>
        s.status === 'running' || s.status === 'pending' ? { ...s, status: 'cancelled' } : s,
      ),
    });
  }

  return {
    homes,

    defaults(): { claude: string; codex: string } {
      return { claude: models.judge, codex: codexDefaultModel(codexConfigPath) };
    },

    scope,

    // 建立分析并在后台开始；返回时状态为 queued 或 running
    create(input: {
      sessionIds?: string[] | undefined;
      batchId?: string | undefined;
      engine: AnalysisEngine;
      model?: string | undefined;
    }): Analysis {
      const s = scope(input);
      if (s.problem !== null || s.variant === null)
        throw new HttpError(400, s.problem ?? '没有 variant');
      const model =
        input.model ??
        (input.engine === 'claude' ? models.judge : codexDefaultModel(codexConfigPath));
      const id = newAnalysisId();
      db.insert(analyses)
        .values({
          id,
          engine: input.engine,
          model,
          variantId: s.variant.id,
          sessionIds: s.sessions.map((x) => x.id),
          status: 'queued',
          steps: analysisStepKeys.map(pendingStep),
        })
        .run();
      const controller = new AbortController();
      controllers.set(id, controller);
      void execute(id, controller)
        .then(
          () => undefined,
          (error: unknown) => {
            finish(id, controller, error);
          },
        )
        .finally(() => controllers.delete(id));
      return get(id);
    },

    list(): (Analysis & { variantName: string })[] {
      return db
        .select()
        .from(analyses)
        .orderBy(desc(analyses.createdAt), desc(analyses.id))
        .all()
        .map((a) => ({ ...a, variantName: variantName(a.variantId) }));
    },

    get,

    detail(id: string): AnalysisDetail {
      const row = get(id);
      const dirs = layoutOf(dataDir, id);
      return {
        ...row,
        variantName: variantName(row.variantId),
        sessions: scopeSessions(row.sessionIds),
        findings: db
          .select()
          .from(analysisFindings)
          .where(eq(analysisFindings.analysisId, id))
          .orderBy(asc(analysisFindings.id))
          .all(),
        patches: db
          .select()
          .from(analysisPatches)
          .where(eq(analysisPatches.analysisId, id))
          .orderBy(asc(analysisPatches.id))
          .all(),
        files:
          row.status === 'succeeded'
            ? (JSON.parse(fs.readFileSync(dirs.proposals, 'utf8')) as FileProposal[])
            : [],
      };
    },

    // 停掉全部引擎进程
    cancel(id: string): Analysis {
      const row = get(id);
      const controller = controllers.get(id);
      if (controller === undefined || (row.status !== 'queued' && row.status !== 'running')) {
        throw new HttpError(409, `分析 ${id} 不在进行中：${row.status}`);
      }
      controller.abort(CANCELLED);
      return get(id);
    },

    // 等待分析结束（测试与关闭服务用）
    async settled(id: string): Promise<Analysis> {
      for (;;) {
        const row = get(id);
        if (row.status !== 'queued' && row.status !== 'running' && !controllers.has(id)) return row;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    },

    // 另存为 variant（Contracts 15.3）：从绑定的 variant 派生草稿，写入接受的修改与编辑后的内容，记录 parent 与 analysis_id
    saveVariant(
      id: string,
      input: { name: string; files: { path: string; content: string }[] },
    ): Variant {
      const row = get(id);
      if (row.status !== 'succeeded') throw new HttpError(409, `分析 ${id} 还没有成功完成`);
      const proposals = new Set(
        (
          JSON.parse(fs.readFileSync(layoutOf(dataDir, id).proposals, 'utf8')) as FileProposal[]
        ).map((f) => f.path),
      );
      const outside = input.files.filter((f) => !proposals.has(f.path));
      if (outside.length > 0) {
        throw new HttpError(
          400,
          `这些文件不在修改建议中：${outside.map((f) => f.path).join('、')}`,
        );
      }
      const created = variants.derive(row.variantId, { name: input.name });
      for (const f of input.files) variants.writeFile(created.id, f.path, f.content);
      db.update(variantsTable)
        .set({ analysisId: id })
        .where(eq(variantsTable.id, created.id))
        .run();
      return variants.get(created.id);
    },

    // 关闭服务：停掉进行中的分析
    async shutdown() {
      const ids = [...controllers.keys()];
      for (const c of controllers.values()) c.abort(CANCELLED);
      for (const id of ids) {
        while (controllers.has(id)) await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
  };
}

export type Insights = ReturnType<typeof createInsights>;
