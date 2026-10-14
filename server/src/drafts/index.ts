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
  type LiveEngine,
  variants as variantsTable,
  workflowDrafts,
} from '../db/schema.js';
import { events } from '../events.js';
import { analysisLayout } from '../insights/index.js';
import type { Live } from '../live/index.js';
import type { LiveDetail } from '../live/views.js';
import { newId } from '../runs/index.js';
import { HttpError } from '../variants/errors.js';
import { displayName } from '../variants/names.js';
import type { Variant, Variants } from '../variants/index.js';
import { writeSkeleton } from '../variants/skills.js';
import {
  assertNewWorkflow,
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
  sessionSkillsDir,
  writeDraftDocs,
} from './dir.js';
import { installSessionSkill } from './skills.js';
import { checkDraftSkills, readDraftDefinition } from './validate.js';
import type {
  CreateDraftBody,
  DraftDiffView,
  DraftView,
  SaveDraftBody,
  SavePlanView,
} from './views.js';

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

const SKILL_STEP = 'skill:';
// 启动会话的一步；id 沿用 W42 时的 start-codex，两种引擎相同，已有草稿记下的步骤照常重试
const START_STEP = 'start-codex';
// mode 为 optimize 时复制分析所用 variant 中的 optimize-from-report（Contracts 19.3）
const OPTIMIZE_SKILL_STEP = 'copy-optimize-skill';

const engineName: Record<LiveEngine, string> = { codex: 'Codex', claude: 'Claude Code' };

const copyLabel: Record<DraftMode, string> = {
  workflow: '写入口与各小阶段的 SKILL.md 骨架',
  variant: '复制底子 variant 的 src',
  optimize: '复制被分析 variant 的 src 到 optimize/src',
};

// 草稿准备的各步（Contracts 17.1、19.3）：复制 src（新 workflow 为写骨架）、写说明与例子、逐个安装 skill、启动会话
function initialSteps(
  mode: DraftMode,
  sources: CodexSkillSources,
  engine: LiveEngine,
): DraftStep[] {
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
    step(START_STEP, `启动 ${engineName[engine]}`),
  ];
}

// 从空白开始的新 workflow 草稿只有一个小阶段，由 Codex 在 workflow.yaml 中改（Contracts 18.5）
const BLANK_STAGES = [{ id: 'stage-1' }];

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// 新 workflow 第一个 variant 的名字的预填（Contracts 17.4）
const FIRST_VARIANT = '初稿';

// 定义相同即入口与小阶段相同（Contracts 19.1）；名字是 workflow 的属性，在 Workflow 页面改
const sameStages = (a: WorkflowDefinition, b: WorkflowDefinition) =>
  isDeepStrictEqual({ id: a.id, stages: a.stages }, { id: b.id, stages: b.stages });

// 保存时 workflow 的名字与描述必填
function checkText(label: string, value: string, max: number): string {
  const text = value.trim();
  if (text === '') throw new HttpError(400, `${label}不能为空`);
  if (text.length > max) {
    throw new HttpError(400, `${label}最多 ${String(max)} 字，现在是 ${String(text.length)} 字`);
  }
  return text;
}

// 用 Codex 生成 workflow 或 variant（Contracts 第 17 节）
export function createDrafts({ db, variants, live, draftsDir, dataDir, skillSources }: DraftsDeps) {
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
      engine: r.engine,
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
      // 已删除的显示"<名字>（已删除）"，不能点进 variant 页面（Contracts 24.3）
      savedVariants: db
        .select({
          id: variantsTable.id,
          name: variantsTable.name,
          workflowId: variantsTable.workflowId,
          deletedAt: variantsTable.deletedAt,
        })
        .from(variantsTable)
        .where(eq(variantsTable.draftId, r.id))
        .orderBy(asc(variantsTable.createdAt))
        .all()
        .map((v) => ({
          id: v.id,
          name: displayName(v),
          workflowId: v.workflowId,
          deleted: v.deletedAt !== null,
        })),
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

  // 分析所用的 session-analysis variant 中的 optimize-from-report 装进优化会话的 skill 目录（Contracts 19.3、22.2）
  function copyOptimizeSkill(d: DraftRow, skillsDir: string) {
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
    const to = path.join(skillsDir, OPTIMIZE_SKILL);
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
        fs.rmSync(layout.claudeSkills, { recursive: true, force: true });
        fs.rmSync(layout.skillsLock, { force: true });
      }
      await copyDraftSource(layout, async (dest) => {
        if (d.baseVariantId === null) writeSkeleton(path.join(dest, 'skills'), definitionOf(d));
        else await variants.exportSource(d.baseVariantId, dest);
      });
    } else if (stepId === 'write-docs') {
      writeDraftDocs(layout, d.mode, definitionOf(d));
    } else if (stepId.startsWith(SKILL_STEP)) {
      const name = stepId.slice(SKILL_STEP.length);
      const source = skillSources.find((s) => s.name === name);
      if (source === undefined) {
        throw new Error(`没有 skill ${name} 的来源（WFD_CODEX_SKILL_SOURCES）`);
      }
      const version = await installSessionSkill(layout, source, d.engine);
      update(id, { skills: [...row(id).skills.filter((s) => s.name !== name), version] });
    } else if (stepId === OPTIMIZE_SKILL_STEP) {
      copyOptimizeSkill(d, sessionSkillsDir(layout, d.engine));
    } else if (stepId === START_STEP) {
      if (d.liveId === null) throw new Error(`草稿 ${id} 的交互项已删除`);
      await live.startDraft(d.liveId);
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
    const item = live.createDraftItem({
      cwd: path.join(draftsDir, id),
      prompt: initialMessage(body.mode, body.requirement, body.engine),
      title:
        body.mode === 'workflow'
          ? `${engineName[body.engine]}：新 workflow ${body.workflowId}`
          : `${engineName[body.engine]}：${body.workflowId} 的新 variant`,
      workflow: body.mode === 'workflow' ? null : body.workflowId,
      purpose: 'design',
      engine: body.engine,
    });
    db.insert(workflowDrafts)
      .values({
        id,
        mode: body.mode,
        engine: body.engine,
        workflowId: body.workflowId,
        name: body.mode === 'workflow' ? body.name : null,
        description: body.mode === 'workflow' ? body.description.trim() : null,
        baseVariantId: base?.id ?? null,
        requirement: body.requirement,
        liveId: item.id,
        status: 'preparing',
        steps: initialSteps(body.mode, skillSources, body.engine),
      })
      .run();
    events.publish({ type: 'draft.updated', draftId: id, status: 'preparing' });
    events.publish({ type: 'live.updated', liveId: item.id });
    return { draft: view(row(id)), live: live.get(item.id) };
  }

  // 交给 agent 优化（Contracts 19.3、22.1）：草稿目录即分析目录，底子是被分析的 variant，所属 workflow 是它的 workflow
  function openOptimize(
    analysisId: string,
    engine: LiveEngine,
  ): { draft: DraftView; live: LiveDetail } {
    const a = analysisRow(analysisId);
    if (a.status !== 'succeeded' || a.report === null) {
      throw new HttpError(409, `分析 ${analysisId} 还没有成功完成，没有报告可以优化`);
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
      engine,
    });
    const id = newId('d');
    const item = live.createDraftItem({
      cwd: analysisLayout(dataDir, analysisId).dir,
      prompt,
      title: `${engineName[engine]}：优化 ${workflowId}（分析 ${analysisId}）`,
      workflow: null,
      purpose: 'optimize',
      engine,
    });
    db.insert(workflowDrafts)
      .values({
        id,
        mode: 'optimize',
        engine,
        workflowId,
        name: null,
        description: null,
        baseVariantId: base.id,
        analysisId,
        requirement: prompt,
        liveId: item.id,
        status: 'preparing',
        steps: initialSteps('optimize', skillSources, engine),
      })
      .run();
    events.publish({ type: 'draft.updated', draftId: id, status: 'preparing' });
    events.publish({ type: 'live.updated', liveId: item.id });
    return { draft: view(row(id)), live: live.get(item.id) };
  }

  // 保存到哪个 workflow（Contracts 17.4、19.3）：定义、是否新建 workflow、新建 variant 时的 parent
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
      // optimize/workflow.yaml 的入口与小阶段与原 workflow 相同：保存到原 workflow，parent 为被分析的 variant
      if (sameStages(loadWorkflow(db, draft.workflowId), definition)) {
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
    // 再次保存：保存到已保存出的新 workflow，入口与小阶段必须没有改动
    const saved = loadWorkflow(db, draft.savedWorkflowId);
    if (!sameStages(saved, definition)) {
      throw new HttpError(
        400,
        `workflow.yaml 与已保存的 workflow ${saved.id} 的定义不同；要改定义就在 Workflow 页面改，或另开草稿。\n已保存：\n${stringify(saved)}\nworkflow.yaml：\n${stringify(definition)}`,
      );
    }
    // 新 workflow 下的 variant 没有 parent：被分析的 variant 属于另一个 workflow
    return {
      definition: saved,
      newWorkflow: false,
      parentId: draft.mode === 'optimize' ? null : draft.baseVariantId,
    };
  }

  // 保存对话框的内容（Contracts 17.4）：第一次保存为新 workflow 时填 workflow 与第一个 variant；
  // 其余情况列出同一 workflow 的 variant，导入的与已冻结的不能被覆盖，写明原因
  function savePlan(id: string): SavePlanView {
    const draft = savableRow(id);
    const { definition, newWorkflow, parentId } = saveTarget(draft);
    if (newWorkflow) {
      return {
        kind: 'new-workflow',
        workflowId: definition.id,
        workflowName: definition.name,
        workflowDescription: newWorkflowDescription(draft),
        variantName: FIRST_VARIANT,
      };
    }
    // 底子已删除时照常显示它的名字（"（已删除）"，Contracts 24.3）
    const parent = parentId === null ? null : variants.record(parentId);
    return {
      kind: 'variant',
      workflowId: definition.id,
      workflowName: definition.name,
      parent: parent === null ? null : { id: parent.id, name: displayName(parent) },
      variants: variants
        .list()
        .filter((v) => v.workflowId === definition.id)
        .reverse()
        .map((v) => ({
          id: v.id,
          name: v.name,
          description: v.description,
          reason: variants.replaceBlocker(v),
        })),
    };
  }

  // 新 workflow 的描述的预填：mode 为 workflow 时是发起时填的，mode 为 optimize 时写明来源
  const newWorkflowDescription = (draft: DraftRow) =>
    draft.mode === 'optimize'
      ? `由 Codex 按分析 ${draft.analysisId ?? ''} 的报告，从 workflow ${draft.workflowId} 改出`
      : (draft.description ?? '');

  // 校验后建 workflow 与 variant，或覆盖已有 variant；不构建，variant 状态为未构建（Contracts 17.4）。
  // 任何一项校验不通过都以原文失败，草稿保留，什么都不改
  function saveDraft(id: string, body: SaveDraftBody): DraftView {
    const draft = row(id);
    const layout = layoutOf(draft);
    const { definition, newWorkflow, parentId } = saveTarget(draft);
    checkDraftSkills(layout, definition);
    const { target } = body;
    const name = variants.checkName(target.name);
    const description = variants.checkDescription(target.description);
    let saved: WorkflowDefinition = definition;
    if (newWorkflow) {
      if (body.workflow === undefined) {
        throw new HttpError(
          400,
          `第一次保存为新 workflow ${definition.id}，要填 workflow 的名字与描述`,
        );
      }
      if (target.kind !== 'new') {
        throw new HttpError(
          400,
          `新 workflow ${definition.id} 还没有 variant，只能新建第一个 variant`,
        );
      }
      saved = { ...definition, name: checkText('workflow 的名字', body.workflow.name, 100) };
      const workflowDescription = checkText('workflow 的描述', body.workflow.description, 2000);
      insertWorkflow(db, saved, workflowDescription);
    } else if (body.workflow !== undefined) {
      throw new HttpError(
        400,
        `保存到已有的 workflow ${definition.id}，不填 workflow 的名字与描述（在 Workflow 页面改）`,
      );
    }
    const source = draft.analysisId === null ? '' : `，分析 ${draft.analysisId}`;
    let variant: Variant;
    if (target.kind === 'new') {
      const parent = parentId === null ? null : variants.record(parentId);
      variant = variants.createFromSource({
        srcDir: layout.src,
        workflowId: saved.id,
        name,
        description,
        parentId,
        draftId: id,
        analysisId: draft.analysisId,
        note: `从 Codex 草稿 ${id} 保存（${parent === null ? '没有底子' : `底子 ${displayName(parent)}，${parent.id}`}${source}），需要构建`,
      });
    } else {
      const existing = variants.get(target.variantId);
      if (existing.workflowId !== saved.id) {
        throw new HttpError(
          400,
          `variant ${existing.name} 属于 workflow ${existing.workflowId}，这个草稿保存到 ${saved.id}，只能覆盖其中的 variant`,
        );
      }
      variant = variants.overwriteFromSource(existing.id, {
        srcDir: layout.src,
        name,
        description,
        draftId: id,
        analysisId: draft.analysisId,
      });
    }
    update(id, { status: 'saved', savedWorkflowId: saved.id, savedVariantId: variant.id });
    return view(row(id));
  }

  const savable: DraftStatus[] = ['open', 'saved'];

  function savableRow(id: string): DraftRow {
    const d = row(id);
    if (!savable.includes(d.status)) {
      throw new HttpError(409, `草稿 ${id} 的状态是 ${d.status}，准备完成后才能保存`);
    }
    return d;
  }

  return {
    get: (id: string) => view(row(id)),

    // 保存前的改动预览（Contracts 17.4、21.3）：将要保存的 src/ 相对目标的 diff。against 为被覆盖的 variant；
    // 不传时相对底子（新建时），从空白开始的草稿没有底子；底子已删除时它的文件已不在，全部算作新增（Contracts 24.3）
    diff(id: string, against: string | undefined): DraftDiffView {
      const d = savableRow(id);
      const baseId = against ?? d.baseVariantId;
      const base = baseId === null ? null : variants.record(baseId);
      return {
        base: base === null ? null : { id: base.id, name: displayName(base) },
        files: variants.diffSource(base?.deletedAt === null ? base.id : null, layoutOf(d).src),
      };
    },

    savePlan,

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
    optimize(analysisId: string, engine: LiveEngine): { draft: DraftView; live: LiveDetail } {
      const created = openOptimize(analysisId, engine);
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

    // 保存（Contracts 17.4）：新建 variant 或覆盖已有 variant，不构建
    save(id: string, body: SaveDraftBody): DraftView {
      savableRow(id);
      return saveDraft(id, body);
    },
  };
}

export type Drafts = ReturnType<typeof createDrafts>;
