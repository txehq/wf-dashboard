import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { asc, eq } from 'drizzle-orm';
import { stringify } from 'yaml';
import type { CodexSkillSources } from '../config.js';
import type { Db } from '../db/index.js';
import {
  analyses,
  analysisFindings,
  analysisPatches,
  type DraftMode,
  type DraftStatus,
  type DraftStep,
  variants as variantsTable,
  workflowDrafts,
} from '../db/schema.js';
import { events } from '../events.js';
import { analysisLayout } from '../insights/index.js';
import type { Live } from '../live/index.js';
import type { LiveDetail } from '../live/views.js';
import { newId } from '../runs/index.js';
import { HttpError } from '../variants/errors.js';
import type { Variant, Variants } from '../variants/index.js';
import { writeSkeleton } from '../variants/skills.js';
import {
  assertNewWorkflow,
  deleteEmptyWorkflow,
  insertWorkflow,
  loadWorkflow,
  parseDefinition,
  workflowOfVariant,
} from '../workflows/index.js';
import { OPTIMIZE_SKILL, type WorkflowDefinition } from '../workflows/schema.js';
import {
  copyDraftSource,
  draftLayout,
  initialMessage,
  optimizeMessage,
  writeDraftDocs,
} from './dir.js';
import { installCodexSkill } from './skills.js';
import { checkDraftSkills, readDraftDefinition } from './validate.js';
import type { CreateDraftBody, DraftView } from './views.js';

export interface DraftsDeps {
  db: Db;
  variants: Variants;
  live: Live;
  // data/workflow-drafts
  draftsDir: string;
  // 数据目录：mode 为 optimize 的草稿目录是其中的 analyses/<id>/
  dataDir: string;
  skillSources: CodexSkillSources;
}

type DraftRow = typeof workflowDrafts.$inferSelect;

// 构建失败时显示的原文：构建日志中最后一步的命令与输出
function lastStep(log: string): string {
  const at = log.lastIndexOf('\n$ [');
  return (at < 0 ? log : log.slice(at + 1)).trim();
}

const SKILL_STEP = 'skill:';
const START_STEP = 'start-codex';
// mode 为 optimize 时复制分析所用 variant 中的 optimize-from-report（Contracts 19.3）
const OPTIMIZE_SKILL_STEP = 'copy-optimize-skill';

const copyLabel: Record<DraftMode, string> = {
  workflow: '写入口与各小阶段的 SKILL.md 骨架',
  variant: '复制底子 variant 的 src',
  optimize: '复制被分析 variant 的 src 到 optimize/src',
};

// 草稿准备的各步（Contracts 17.1、19.3）：复制 src（新 workflow 为写骨架）、写说明与例子、逐个安装 skill、启动 Codex
function initialSteps(mode: DraftMode, sources: CodexSkillSources): DraftStep[] {
  const step = (id: string, label: string): DraftStep => ({
    id,
    label,
    status: 'pending',
    error: null,
    startedAt: null,
    endedAt: null,
  });
  return [
    step('copy-src', copyLabel[mode]),
    step('write-docs', '写 workflow.yaml、PLATFORM.md 与例子 workflow'),
    ...sources.map((s) => step(`${SKILL_STEP}${s.name}`, `安装 ${s.name}`)),
    ...(mode === 'optimize' ? [step(OPTIMIZE_SKILL_STEP, `复制 ${OPTIMIZE_SKILL}`)] : []),
    step(START_STEP, '启动 Codex'),
  ];
}

// 从空白开始的新 workflow 草稿只有一个小阶段，由 Codex 在 workflow.yaml 中改（Contracts 18.5）
const BLANK_STAGES = [{ id: 'stage-1' }];

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// 用 Codex 生成 workflow 或 variant（Contracts 第 17 节）
export function createDrafts({ db, variants, live, draftsDir, dataDir, skillSources }: DraftsDeps) {
  // 正在保存的草稿：同一草稿同时只保存一次
  const saving = new Set<string>();

  // 上次服务退出时还在准备的草稿不会再完成：那一步记为失败，可以重试
  const interrupted = db
    .select()
    .from(workflowDrafts)
    .where(eq(workflowDrafts.status, 'preparing'))
    .all();
  for (const d of interrupted) {
    const error = '服务重启，准备中断';
    db.update(workflowDrafts)
      .set({
        status: 'failed',
        error,
        steps: d.steps.map((s) =>
          s.status === 'running' ? { ...s, status: 'failed', error, endedAt: Date.now() } : s,
        ),
      })
      .where(eq(workflowDrafts.id, d.id))
      .run();
  }

  function row(id: string): DraftRow {
    const found = db.select().from(workflowDrafts).where(eq(workflowDrafts.id, id)).get();
    if (found === undefined) throw new HttpError(404, `草稿不存在：${id}`);
    return found;
  }

  const dirOf = (r: Pick<DraftRow, 'id' | 'analysisId'>) =>
    r.analysisId === null ? path.join(draftsDir, r.id) : analysisLayout(dataDir, r.analysisId).dir;
  const layoutOf = (r: Pick<DraftRow, 'id' | 'mode' | 'analysisId'>) =>
    draftLayout(dirOf(r), r.mode);

  function view(r: DraftRow): DraftView {
    return {
      id: r.id,
      mode: r.mode,
      workflowId: r.workflowId,
      name: r.name,
      description: r.description,
      baseVariantId: r.baseVariantId,
      analysisId: r.analysisId,
      requirement: r.requirement,
      liveId: r.liveId,
      status: r.status,
      error: r.error,
      steps: r.steps,
      savedWorkflowId: r.savedWorkflowId,
      savedVariantId: r.savedVariantId,
      savedVariants: db
        .select({
          id: variantsTable.id,
          name: variantsTable.name,
          workflowId: variantsTable.workflowId,
        })
        .from(variantsTable)
        .where(eq(variantsTable.draftId, r.id))
        .orderBy(asc(variantsTable.createdAt))
        .all(),
      skills: r.skills,
      dir: layoutOf(r).dir,
      createdAt: r.createdAt.getTime(),
    };
  }

  // 状态与进度写入后推送：草稿与它的交互项都重新读取
  function update(id: string, values: Partial<DraftRow>) {
    db.update(workflowDrafts).set(values).where(eq(workflowDrafts.id, id)).run();
    const r = row(id);
    events.publish({ type: 'draft.updated', draftId: id, status: r.status });
    if (r.liveId !== null) events.publish({ type: 'live.updated', liveId: r.liveId });
  }

  function setStep(id: string, stepId: string, values: Partial<DraftStep>) {
    update(id, {
      steps: row(id).steps.map((s) => (s.id === stepId ? { ...s, ...values } : s)),
    });
  }

  // 草稿的定义：mode 为 workflow 时是 id、名字与一个小阶段的空白定义；mode 为 variant、optimize 时是所属 workflow 的定义
  function definitionOf(d: Pick<DraftRow, 'mode' | 'workflowId' | 'name'>) {
    if (d.mode !== 'workflow') return loadWorkflow(db, d.workflowId);
    return parseDefinition(
      { id: d.workflowId, name: d.name, stages: BLANK_STAGES },
      `新 workflow ${d.workflowId} 的定义`,
    );
  }

  function analysisRow(analysisId: string) {
    const a = db.select().from(analyses).where(eq(analyses.id, analysisId)).get();
    if (a === undefined) throw new HttpError(404, `分析不存在：${analysisId}`);
    return a;
  }

  // 分析所用的 session-analysis variant 中的 optimize-from-report 装进优化会话的 .agents/skills（Contracts 19.3）
  function copyOptimizeSkill(d: DraftRow, agentSkills: string) {
    if (d.analysisId === null) throw new Error(`草稿 ${d.id} 不是优化草稿`);
    const a = analysisRow(d.analysisId);
    if (a.analysisVariantId === null) {
      throw new Error(`分析 ${a.id} 没有记录所用的 session-analysis variant`);
    }
    const from = path.join(variants.layout(a.analysisVariantId).skills, OPTIMIZE_SKILL);
    if (!fs.existsSync(path.join(from, 'SKILL.md'))) {
      throw new Error(
        `分析 ${a.id} 所用的 variant ${variants.get(a.analysisVariantId).name} 中没有 ${OPTIMIZE_SKILL}（应为 src/skills/${OPTIMIZE_SKILL}/SKILL.md）`,
      );
    }
    const to = path.join(agentSkills, OPTIMIZE_SKILL);
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true });
  }

  async function runStep(id: string, stepId: string) {
    const d = row(id);
    const layout = layoutOf(d);
    if (stepId === 'copy-src') {
      if (d.mode === 'optimize') {
        // 分析目录中可能有 Codex 引擎用过的 session-analysis skill，优化会话只装自己的 skill
        fs.rmSync(path.dirname(layout.agentSkills), { recursive: true, force: true });
        fs.rmSync(layout.skillsLock, { force: true });
      }
      copyDraftSource(layout, (dest) => {
        if (d.baseVariantId === null) writeSkeleton(path.join(dest, 'skills'), definitionOf(d));
        else variants.exportSource(d.baseVariantId, dest);
      });
    } else if (stepId === 'write-docs') {
      writeDraftDocs(layout, d.mode, definitionOf(d));
    } else if (stepId.startsWith(SKILL_STEP)) {
      const name = stepId.slice(SKILL_STEP.length);
      const source = skillSources.find((s) => s.name === name);
      if (source === undefined) {
        throw new Error(`没有 skill ${name} 的来源（WFD_CODEX_SKILL_SOURCES）`);
      }
      const version = await installCodexSkill(layout, source);
      update(id, { skills: [...row(id).skills.filter((s) => s.name !== name), version] });
    } else if (stepId === OPTIMIZE_SKILL_STEP) {
      copyOptimizeSkill(d, layout.agentSkills);
    } else if (stepId === START_STEP) {
      if (d.liveId === null) throw new Error(`草稿 ${id} 的交互项已删除`);
      await live.startCodex(d.liveId);
    } else {
      throw new Error(`未知的准备步骤：${stepId}`);
    }
  }

  // 从第一步没有完成的步骤接着做（重试时即失败的那一步）；准备完成后状态为 open，再启动 Codex
  async function prepare(id: string) {
    for (const step of row(id).steps) {
      if (step.status === 'done') continue;
      if (step.id === START_STEP) update(id, { status: 'open' });
      setStep(id, step.id, {
        status: 'running',
        error: null,
        startedAt: Date.now(),
        endedAt: null,
      });
      const failed = await runStep(id, step.id).then(
        () => null,
        (error: unknown) => message(error),
      );
      if (failed !== null) {
        setStep(id, step.id, { status: 'failed', error: failed, endedAt: Date.now() });
        update(id, { status: 'failed', error: `${step.label}失败：${failed}` });
        return;
      }
      setStep(id, step.id, { status: 'done', endedAt: Date.now() });
    }
  }

  // 建草稿与它在 Live 中的项（还没有进程）；草稿目录由 prepare 在后台准备
  function open(body: CreateDraftBody): { draft: DraftView; live: LiveDetail } {
    let base: Variant | null = null;
    if (body.mode === 'workflow') {
      assertNewWorkflow(
        db,
        definitionOf({ mode: 'workflow', workflowId: body.workflowId, name: body.name }),
      );
    } else {
      loadWorkflow(db, body.workflowId);
      base = variants.get(body.baseVariantId);
      if (base.workflowId !== body.workflowId) {
        throw new HttpError(
          400,
          `底子 variant ${base.name} 属于 workflow ${base.workflowId}，不是 ${body.workflowId} 的 variant`,
        );
      }
    }
    const id = newId('d');
    const item = live.createCodexItem({
      cwd: path.join(draftsDir, id),
      prompt: initialMessage(body.mode, body.requirement),
      title:
        body.mode === 'workflow'
          ? `Codex：新 workflow ${body.workflowId}`
          : `Codex：${body.workflowId} 的新 variant`,
      workflow: body.mode === 'workflow' ? null : body.workflowId,
    });
    db.insert(workflowDrafts)
      .values({
        id,
        mode: body.mode,
        workflowId: body.workflowId,
        name: body.mode === 'workflow' ? body.name : null,
        description: body.mode === 'workflow' ? body.description.trim() : null,
        baseVariantId: base?.id ?? null,
        requirement: body.requirement,
        liveId: item.id,
        status: 'preparing',
        steps: initialSteps(body.mode, skillSources),
      })
      .run();
    events.publish({ type: 'draft.updated', draftId: id, status: 'preparing' });
    events.publish({ type: 'live.updated', liveId: item.id });
    return { draft: view(row(id)), live: live.get(item.id) };
  }

  // 交给 Codex 优化（Contracts 19.3）：草稿目录即分析目录，底子是被分析的 variant，所属 workflow 是它的 workflow
  function openOptimize(analysisId: string): { draft: DraftView; live: LiveDetail } {
    const a = analysisRow(analysisId);
    if (a.status !== 'succeeded' || a.report === null) {
      throw new HttpError(409, `分析 ${analysisId} 还没有成功完成，没有报告可以交给 Codex`);
    }
    const base = variants.get(a.variantId);
    const workflowId = workflowOfVariant(db, base.id);
    const findings = db
      .select({ severity: analysisFindings.severity })
      .from(analysisFindings)
      .where(eq(analysisFindings.analysisId, analysisId))
      .all();
    const count = (s: string) => findings.filter((f) => f.severity === s).length;
    const prompt = optimizeMessage({
      analysisId,
      workflowId,
      variantName: base.name,
      report: a.report,
      findings: { high: count('high'), medium: count('medium'), low: count('low') },
      patches: db
        .select({ id: analysisPatches.id })
        .from(analysisPatches)
        .where(eq(analysisPatches.analysisId, analysisId))
        .all().length,
    });
    const id = newId('d');
    const item = live.createCodexItem({
      cwd: analysisLayout(dataDir, analysisId).dir,
      prompt,
      title: `Codex：优化 ${workflowId}（分析 ${analysisId}）`,
      workflow: null,
    });
    db.insert(workflowDrafts)
      .values({
        id,
        mode: 'optimize',
        workflowId,
        name: null,
        description: null,
        baseVariantId: base.id,
        analysisId,
        requirement: prompt,
        liveId: item.id,
        status: 'preparing',
        steps: initialSteps('optimize', skillSources),
      })
      .run();
    events.publish({ type: 'draft.updated', draftId: id, status: 'preparing' });
    events.publish({ type: 'live.updated', liveId: item.id });
    return { draft: view(row(id)), live: live.get(item.id) };
  }

  // 保存的目标（Contracts 17.4、19.3）：定义、是否新建 workflow、parent
  function saveTarget(draft: DraftRow): {
    definition: WorkflowDefinition;
    newWorkflow: boolean;
    parentId: string | null;
  } {
    const layout = layoutOf(draft);
    if (draft.mode === 'variant') {
      return {
        definition: loadWorkflow(db, draft.workflowId),
        newWorkflow: false,
        parentId: draft.baseVariantId,
      };
    }
    const definition = readDraftDefinition(layout);
    if (draft.mode === 'optimize') {
      // optimize/workflow.yaml 与原定义相同：原 workflow 的新 variant，parent 为被分析的 variant
      if (isDeepStrictEqual(loadWorkflow(db, draft.workflowId), definition)) {
        return { definition, newWorkflow: false, parentId: draft.baseVariantId };
      }
      if (draft.savedWorkflowId === null || draft.savedWorkflowId === draft.workflowId) {
        assertNewWorkflow(db, definition);
        return { definition, newWorkflow: true, parentId: null };
      }
    } else if (draft.savedWorkflowId === null) {
      assertNewWorkflow(db, definition);
      return { definition, newWorkflow: true, parentId: draft.baseVariantId };
    }
    // 再次保存：在已保存的新 workflow 下建新 variant，定义必须没有改动
    const saved = loadWorkflow(db, draft.savedWorkflowId);
    if (!isDeepStrictEqual(saved, definition)) {
      throw new HttpError(
        400,
        `workflow.yaml 与已保存的 workflow ${saved.id} 的定义不同；要改定义就在 Workflow 页面改，或另开草稿。\n已保存：\n${stringify(saved)}\nworkflow.yaml：\n${stringify(definition)}`,
      );
    }
    // 新 workflow 下的 variant 没有 parent：被分析的 variant 属于另一个 workflow
    return {
      definition,
      newWorkflow: false,
      parentId: draft.mode === 'optimize' ? null : draft.baseVariantId,
    };
  }

  // 新 workflow 的描述：mode 为 workflow 时是发起时填的，mode 为 optimize 时写明来源
  const newWorkflowDescription = (draft: DraftRow) =>
    draft.mode === 'optimize'
      ? `由 Codex 按分析 ${draft.analysisId ?? ''} 的报告，从 workflow ${draft.workflowId} 改出`
      : (draft.description ?? '');

  // 校验、建 workflow 与 variant、构建；任何一步失败都以原文 400，草稿保留，这次建出的 workflow 与 variant 删去
  async function saveDraft(id: string): Promise<DraftView> {
    const draft = row(id);
    const layout = layoutOf(draft);
    const { definition, newWorkflow, parentId } = saveTarget(draft);
    checkDraftSkills(layout, definition);
    if (newWorkflow) insertWorkflow(db, definition, newWorkflowDescription(draft));
    const parent = parentId === null ? null : variants.get(parentId);
    const variant = variants.createFromSource({
      srcDir: layout.src,
      workflowId: definition.id,
      name: newWorkflow ? '基线' : variants.freeName(definition.id, `Codex ${id}`),
      parentId,
      draftId: id,
      analysisId: draft.analysisId,
      note: `从 Codex 草稿 ${id} 保存（${parent === null ? '没有底子' : `底子 ${parent.name}，${parent.id}`}${draft.analysisId === null ? '' : `，分析 ${draft.analysisId}`}）`,
    });
    await variants.build(variant.id).then(
      () => undefined,
      (error: unknown) => {
        // 构建失败的原文是构建日志的最后一步
        const log = lastStep(variants.buildLog(variant.id));
        variants.removeUnused(variant.id);
        if (newWorkflow) deleteEmptyWorkflow(db, definition.id);
        throw new HttpError(400, `构建失败：${message(error)}\n${log}`);
      },
    );
    update(id, { status: 'saved', savedWorkflowId: definition.id, savedVariantId: variant.id });
    return view(row(id));
  }

  const savable: DraftStatus[] = ['open', 'saved'];

  return {
    get: (id: string) => view(row(id)),

    open,

    // 在后台准备草稿目录；返回的 promise 在准备结束（完成或某一步失败）时完成，测试可以等它
    prepare,

    // 发起（Contracts 17.1）：立即建草稿与 Live 项并返回，草稿目录在后台准备
    create(body: CreateDraftBody): { draft: DraftView; live: LiveDetail } {
      const created = open(body);
      void prepare(created.draft.id);
      return created;
    },

    openOptimize,

    // 交给 Codex 优化（Contracts 19.3）：与发起相同，立即返回，分析目录中的准备在后台进行
    optimize(analysisId: string): { draft: DraftView; live: LiveDetail } {
      const created = openOptimize(analysisId);
      void prepare(created.draft.id);
      return created;
    },

    // 重试准备：从失败的那一步接着做
    retry(id: string): DraftView {
      const d = row(id);
      if (d.status !== 'failed') {
        throw new HttpError(409, `草稿 ${id} 的状态是 ${d.status}，只有准备失败的草稿可以重试`);
      }
      update(id, { status: 'preparing', error: null });
      void prepare(id);
      return view(row(id));
    },

    // 保存（Contracts 17.4）：同一草稿同时只保存一次
    async save(id: string): Promise<DraftView> {
      const d = row(id);
      if (!savable.includes(d.status)) {
        throw new HttpError(409, `草稿 ${id} 的状态是 ${d.status}，准备完成后才能保存`);
      }
      if (saving.has(id)) throw new HttpError(409, `草稿 ${id} 正在保存`);
      saving.add(id);
      return saveDraft(id).finally(() => {
        saving.delete(id);
      });
    },
  };
}

export type Drafts = ReturnType<typeof createDrafts>;
