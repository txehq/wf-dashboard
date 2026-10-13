import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@decimalturn/toml-patch';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import {
  type AnalysisEngine,
  analyses,
  analysisFindings,
  analysisPatches,
  type AnalysisStep,
  runs,
  sessions,
  userMessages,
  type VariantBinding,
  variants as variantsTable,
  workflowDrafts,
} from '../db/schema.js';
import { sessionTitle } from '../api/user-text.js';
import { events } from '../events.js';
import { models } from '../llm/client.js';
import { writeCodexHome } from '../variants/codex-home.js';
import { HttpError } from '../variants/errors.js';
import type { Variants } from '../variants/index.js';
import { loadWorkflow, workflowOfVariant } from '../workflows/index.js';
import { ANALYSIS_WORKFLOW, SYNTHESIZE_STAGE } from '../workflows/schema.js';
import { currentAnalysisBaseline } from './baseline.js';
import { type EngineCommand, engineCommand, runEngine } from './engines.js';
import { writeInput } from './export.js';
import { analysisSandboxProfile } from './sandbox.js';
import {
  evidenceIndex,
  type FileProposal,
  findingsFile,
  validateFindings,
  validatePatches,
  validateReport,
  type ValidatedFinding,
  writeFindingsWithIds,
} from './validate.js';

// Contracts 15.2、15.3、19.2：分析 session、修改建议另存为 variant。分析的方面是所选 session-analysis variant 的
// 小阶段，每个阶段的引擎进程由这个 variant 的对应 skill 驱动

export type Analysis = typeof analyses.$inferSelect;
type Variant = typeof variantsTable.$inferSelect;

export interface InsightsOptions {
  db: Db;
  variants: Variants;
  dataDir: string;
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

// 引擎进程的提示：调用入口 skill，参数为阶段名（Contracts 19.2）。Claude Code 用 slash 命令，Codex 用 $skill 提及
export function stagePrompt(engine: AnalysisEngine, stage: string): string {
  return engine === 'claude' ? `/${ANALYSIS_WORKFLOW} ${stage}` : `$${ANALYSIS_WORKFLOW} ${stage}`;
}

const pendingStep = (key: string): AnalysisStep => ({
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
  analysisVariantName: string | null;
  sessions: ScopeSession[];
  findings: (typeof analysisFindings.$inferSelect)[];
  patches: (typeof analysisPatches.$inferSelect)[];
  files: FileProposal[];
  // 交给 Codex 优化的草稿（Contracts 19.3），按发起的先后
  optimizeDrafts: { id: string; liveId: string | null }[];
}

// 一个阶段的引擎进程：提示、配置目录、sandbox 与完整的命令（Contracts 19.2）
export interface StagePlan {
  key: string;
  prompt: string;
  engineHome: string;
  // 引擎从这里加载这个 variant 的 skill
  skillsDir: string;
  profile: string;
  command: EngineCommand;
}

export const analysisLayout = (dataDir: string, id: string) => {
  const dir = path.join(dataDir, 'analyses', id);
  return {
    dir,
    input: path.join(dir, 'input'),
    output: path.join(dir, 'output'),
    logs: path.join(dir, 'logs'),
    check: path.join(dir, 'check'),
    proposals: path.join(dir, 'proposals.json'),
    // Codex 引擎从 cwd 的 .agents/skills 加载 skill（Contracts 17.3、19.2）
    agentSkills: path.join(dir, '.agents', 'skills'),
  };
};

export function createInsights({
  db,
  variants,
  dataDir,
  codexAuthPath = config.codexAuthPath,
  codexConfigPath = config.codexConfigPath,
}: InsightsOptions) {
  const controllers = new Map<string, AbortController>();
  // Codex 引擎共用的 CODEX_HOME；Claude Code 引擎用所选 variant 自己的配置目录（Contracts 18.6）
  const homes = { codex: path.join(dataDir, 'analysis-home', 'codex') };

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
  function updateStep(id: string, key: string, change: Partial<AnalysisStep>) {
    const row = get(id);
    const steps = row.steps.map((s) => (s.key === key ? { ...s, ...change } : s));
    const cost = steps.some((s) => s.costUsd !== null)
      ? steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0)
      : null;
    update(id, { steps, costUsd: cost });
  }
  function countEvent(id: string, key: string) {
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

  // 新建分析可选的 session-analysis variant：按当前内容构建通过的（Contracts 19.2）
  function analysisVariants(): Variant[] {
    return db
      .select()
      .from(variantsTable)
      .where(eq(variantsTable.workflowId, ANALYSIS_WORKFLOW))
      .orderBy(desc(variantsTable.createdAt))
      .all()
      .filter((v) => v.buildStatus === 'built' && v.builtHash === v.skillsHash);
  }

  // 分析的步骤：session-analysis 的小阶段，最后一个是 synthesize
  function stageKeys(): { aspects: string[]; synthesize: string } {
    const ids = loadWorkflow(db, ANALYSIS_WORKFLOW).stages.map((s) => s.id);
    const last = ids.at(-1);
    if (last !== SYNTHESIZE_STAGE) {
      throw new Error(
        `workflow ${ANALYSIS_WORKFLOW} 的最后一个小阶段应为 ${SYNTHESIZE_STAGE}：${String(last)}`,
      );
    }
    return { aspects: ids.slice(0, -1), synthesize: last };
  }

  function checkedAnalysisVariant(variantId: string): Variant {
    const v = variants.get(variantId);
    if (workflowOfVariant(db, v.id) !== ANALYSIS_WORKFLOW) {
      throw new HttpError(
        400,
        `variant ${v.name} 属于 workflow ${v.workflowId}，分析只能用 ${ANALYSIS_WORKFLOW} 的 variant`,
      );
    }
    if (v.buildStatus !== 'built' || v.builtHash !== v.skillsHash) {
      throw new HttpError(409, `variant ${v.name} 还没有按当前内容构建，构建通过后才能用于分析`);
    }
    return v;
  }

  // 每个阶段的引擎进程（不启动）：Claude Code 的 CLAUDE_CONFIG_DIR 是所选 variant 自己的配置目录，其中 skills/
  // 即这个 variant 的 skill；Codex 的 skill 复制进分析目录的 .agents/skills。认证与模型配置每次照 7.10 刷新
  function planStages(
    row: Pick<Analysis, 'id' | 'engine' | 'model' | 'analysisVariantId' | 'steps'>,
  ): StagePlan[] {
    if (row.analysisVariantId === null)
      throw new Error(`分析 ${row.id} 没有 session-analysis variant`);
    const dirs = analysisLayout(dataDir, row.id);
    const variantId = checkedAnalysisVariant(row.analysisVariantId).id;
    let engineHome: string;
    let skillsDir: string;
    if (row.engine === 'claude') {
      variants.refreshAuthEnv(variantId);
      engineHome = variants.runtimeEnv(variantId).env.CLAUDE_CONFIG_DIR;
      skillsDir = path.join(engineHome, 'skills');
    } else {
      writeCodexHome(homes.codex, { authPath: codexAuthPath, configPath: codexConfigPath });
      engineHome = homes.codex;
      skillsDir = dirs.agentSkills;
      fs.rmSync(skillsDir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(skillsDir), { recursive: true });
      fs.cpSync(variants.layout(variantId).skills, skillsDir, { recursive: true });
    }
    const profile = analysisSandboxProfile({
      analysisDir: dirs.dir,
      engineHome,
      repoRoot: config.repoRoot,
      dataDir,
    });
    return row.steps.map(({ key }) => {
      const prompt = stagePrompt(row.engine, key);
      return {
        key,
        prompt,
        engineHome,
        skillsDir,
        profile,
        command: engineCommand({ engine: row.engine, model: row.model, prompt, engineHome }),
      };
    });
  }

  async function runStep(row: Analysis, plan: StagePlan, signal: AbortSignal): Promise<void> {
    const dirs = analysisLayout(dataDir, row.id);
    updateStep(row.id, plan.key, { status: 'running', startedAt: Date.now() });
    const result = await runEngine({
      engine: row.engine,
      command: plan.command,
      cwd: dirs.dir,
      engineHome: plan.engineHome,
      profile: plan.profile,
      logFile: path.join(dirs.logs, `${plan.key}.log`),
      signal,
      onEvent: () => {
        countEvent(row.id, plan.key);
      },
    });
    updateStep(row.id, plan.key, { tokens: result.tokens, costUsd: result.costUsd });
  }

  // 一步完成后的校验也算在这一步里：失败时这一步记为 failed，原文写进 error
  async function step<T>(
    row: Analysis,
    plan: StagePlan,
    signal: AbortSignal,
    check: () => T | Promise<T>,
  ): Promise<T> {
    return runStep(row, plan, signal)
      .then(check)
      .then(
        (value) => {
          updateStep(row.id, plan.key, { status: 'succeeded', endedAt: Date.now() });
          return value;
        },
        (error: unknown) => {
          const cancelled = signal.aborted;
          updateStep(row.id, plan.key, {
            status: cancelled ? 'cancelled' : 'failed',
            endedAt: Date.now(),
            error: cancelled ? null : error instanceof Error ? error.message : String(error),
          });
          throw error;
        },
      );
  }

  function planOf(plans: StagePlan[], key: string): StagePlan {
    const plan = plans.find((p) => p.key === key);
    if (plan === undefined) throw new Error(`没有阶段 ${key} 的引擎进程`);
    return plan;
  }

  async function execute(id: string, controller: AbortController) {
    const { signal } = controller;
    const dirs = analysisLayout(dataDir, id);
    update(id, { status: 'running' });
    const row = get(id);
    for (const dir of [dirs.output, dirs.logs]) fs.mkdirSync(dir, { recursive: true });
    const exported = await writeInput(db, {
      analysisId: id,
      variant: { id: row.variantId, name: variantName(row.variantId) },
      skillsDir: variants.layout(row.variantId).skills,
      workflow: loadWorkflow(db, workflowOfVariant(db, row.variantId)),
      sessionIds: row.sessionIds,
      inputDir: dirs.input,
    });
    signal.throwIfAborted();
    const index = evidenceIndex(exported);
    const plans = planStages(row);
    const { aspects, synthesize } = stageKeys();

    const found = await Promise.all(
      aspects.map((aspect) =>
        step(row, planOf(plans, aspect), signal, () => {
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

    const findingIds = new Set(findings.map((f) => f.findingId));
    const { proposal, report } = await step(row, planOf(plans, synthesize), signal, async () => ({
      proposal: await validatePatches(
        path.join(dirs.output, 'patches.json'),
        path.join(dirs.input, 'skills'),
        dirs.check,
        findingIds,
      ),
      report: validateReport(path.join(dirs.output, 'report.json'), findingIds),
    }));
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
    update(id, { status: 'succeeded', report, endedAt: new Date() });
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

  // 新分析的一行（还没有写入）
  function newRow(input: {
    sessionIds?: string[] | undefined;
    batchId?: string | undefined;
    engine: AnalysisEngine;
    model?: string | undefined;
    analysisVariantId?: string | undefined;
  }): Pick<
    Analysis,
    | 'id'
    | 'engine'
    | 'model'
    | 'variantId'
    | 'analysisVariantId'
    | 'sessionIds'
    | 'status'
    | 'steps'
  > {
    const s = scope(input);
    if (s.problem !== null || s.variant === null)
      throw new HttpError(400, s.problem ?? '没有 variant');
    const analysisVariantId = input.analysisVariantId ?? currentAnalysisBaseline(db)?.id;
    if (analysisVariantId === undefined) {
      throw new HttpError(409, `还没有 ${ANALYSIS_WORKFLOW} 的基线 variant（服务启动时建出）`);
    }
    checkedAnalysisVariant(analysisVariantId);
    const model =
      input.model ??
      (input.engine === 'claude' ? models.judge : codexDefaultModel(codexConfigPath));
    const { aspects, synthesize } = stageKeys();
    return {
      id: newAnalysisId(),
      engine: input.engine,
      model,
      variantId: s.variant.id,
      analysisVariantId,
      sessionIds: s.sessions.map((x) => x.id),
      status: 'queued',
      steps: [...aspects, synthesize].map(pendingStep),
    };
  }

  return {
    homes,

    defaults(): { claude: string; codex: string; analysisVariantId: string | null } {
      return {
        claude: models.judge,
        codex: codexDefaultModel(codexConfigPath),
        analysisVariantId: currentAnalysisBaseline(db)?.id ?? null,
      };
    },

    analysisVariants,

    scope,

    // 每个阶段的引擎进程与调用参数，不建分析、不启动引擎（测试用：参数由所选 variant 的 skill 决定）
    plan(input: Parameters<typeof newRow>[0]): StagePlan[] {
      return planStages(newRow(input));
    },

    // 建立分析并在后台开始；返回时状态为 queued 或 running
    create(input: Parameters<typeof newRow>[0]): Analysis {
      const values = newRow(input);
      db.insert(analyses).values(values).run();
      const row = get(values.id);
      const controller = new AbortController();
      controllers.set(row.id, controller);
      void execute(row.id, controller)
        .then(
          () => undefined,
          (error: unknown) => {
            finish(row.id, controller, error);
          },
        )
        .finally(() => controllers.delete(row.id));
      return get(row.id);
    },

    list(): (Analysis & { variantName: string; analysisVariantName: string | null })[] {
      return db
        .select()
        .from(analyses)
        .orderBy(desc(analyses.createdAt), desc(analyses.id))
        .all()
        .map((a) => ({
          ...a,
          variantName: variantName(a.variantId),
          analysisVariantName:
            a.analysisVariantId === null ? null : variantName(a.analysisVariantId),
        }));
    },

    get,

    detail(id: string): AnalysisDetail {
      const row = get(id);
      const dirs = analysisLayout(dataDir, id);
      return {
        ...row,
        variantName: variantName(row.variantId),
        analysisVariantName:
          row.analysisVariantId === null ? null : variantName(row.analysisVariantId),
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
        optimizeDrafts: db
          .select({ id: workflowDrafts.id, liveId: workflowDrafts.liveId })
          .from(workflowDrafts)
          .where(eq(workflowDrafts.analysisId, id))
          .orderBy(asc(workflowDrafts.createdAt))
          .all(),
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
          JSON.parse(
            fs.readFileSync(analysisLayout(dataDir, id).proposals, 'utf8'),
          ) as FileProposal[]
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
