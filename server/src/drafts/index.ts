import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { asc, eq } from 'drizzle-orm';
import { stringify } from 'yaml';
import type { CodexSkillSources } from '../config.js';
import type { Db } from '../db/index.js';
import {
  type DraftStatus,
  type DraftStep,
  variants as variantsTable,
  workflowDrafts,
} from '../db/schema.js';
import { events } from '../events.js';
import type { Live } from '../live/index.js';
import type { LiveDetail } from '../live/views.js';
import { newId } from '../runs/index.js';
import { HttpError } from '../variants/errors.js';
import type { Variants } from '../variants/index.js';
import {
  assertNewWorkflow,
  deleteEmptyWorkflow,
  insertWorkflow,
  loadWorkflow,
  parseDefinition,
} from '../workflows/index.js';
import type { WorkflowDefinition } from '../workflows/schema.js';
import { copyDraftSource, draftLayout, initialMessage, writeDraftDocs } from './dir.js';
import { installCodexSkill } from './skills.js';
import { checkDraftSkills, readDraftDefinition } from './validate.js';
import type { CreateDraftBody, DraftView } from './views.js';

export interface DraftsDeps {
  db: Db;
  variants: Variants;
  live: Live;
  // data/workflow-drafts
  draftsDir: string;
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

// 草稿准备的各步（Contracts 17.1）：复制 src、写说明与例子、逐个安装 skill、启动 Codex
function initialSteps(sources: CodexSkillSources): DraftStep[] {
  const step = (id: string, label: string): DraftStep => ({
    id,
    label,
    status: 'pending',
    error: null,
    startedAt: null,
    endedAt: null,
  });
  return [
    step('copy-src', '复制底子 variant 的 src'),
    step('write-docs', '写 workflow.yaml、PLATFORM.md 与例子 workflow'),
    ...sources.map((s) => step(`${SKILL_STEP}${s.name}`, `安装 ${s.name}`)),
    step(START_STEP, '启动 Codex'),
  ];
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// 用 Codex 生成 workflow 或 variant（Contracts 第 17 节）
export function createDrafts({ db, variants, live, draftsDir, skillSources }: DraftsDeps) {
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

  const layoutOf = (id: string) => draftLayout(path.join(draftsDir, id));

  function view(r: DraftRow): DraftView {
    return {
      id: r.id,
      mode: r.mode,
      workflowId: r.workflowId,
      name: r.name,
      baseVariantId: r.baseVariantId,
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
      dir: layoutOf(r.id).dir,
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

  // 草稿的定义：mode 为 workflow 时先填 id、名字与底子的小阶段；mode 为 variant 时是所属 workflow 的定义
  function definitionOf(d: Pick<DraftRow, 'mode' | 'workflowId' | 'name' | 'baseVariantId'>) {
    if (d.mode === 'variant') return loadWorkflow(db, d.workflowId);
    return parseDefinition(
      {
        id: d.workflowId,
        name: d.name,
        stages: loadWorkflow(db, variants.get(d.baseVariantId).workflowId).stages,
      },
      `新 workflow ${d.workflowId} 的定义`,
    );
  }

  async function runStep(id: string, stepId: string) {
    const d = row(id);
    const layout = layoutOf(id);
    if (stepId === 'copy-src') {
      copyDraftSource(layout, (dest) => {
        variants.exportSource(d.baseVariantId, dest);
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
    const base = variants.get(body.baseVariantId);
    if (body.mode === 'workflow') {
      assertNewWorkflow(
        db,
        definitionOf({
          mode: 'workflow',
          workflowId: body.workflowId,
          name: body.name,
          baseVariantId: base.id,
        }),
      );
    } else {
      loadWorkflow(db, body.workflowId);
      if (base.workflowId !== body.workflowId) {
        throw new HttpError(
          400,
          `底子 variant ${base.name} 属于 workflow ${base.workflowId}，不是 ${body.workflowId} 的 variant`,
        );
      }
    }
    const id = newId('d');
    const item = live.createCodexItem({
      cwd: layoutOf(id).dir,
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
        baseVariantId: base.id,
        requirement: body.requirement,
        liveId: item.id,
        status: 'preparing',
        steps: initialSteps(skillSources),
      })
      .run();
    events.publish({ type: 'draft.updated', draftId: id, status: 'preparing' });
    events.publish({ type: 'live.updated', liveId: item.id });
    return { draft: view(row(id)), live: live.get(item.id) };
  }

  // 校验、建 workflow 与 variant、构建；任何一步失败都以原文 400，草稿保留，这次建出的 workflow 与 variant 删去
  async function saveDraft(id: string): Promise<DraftView> {
    const draft = row(id);
    const layout = layoutOf(id);
    const base = variants.get(draft.baseVariantId);
    let definition: WorkflowDefinition;
    const newWorkflow = draft.mode === 'workflow' && draft.savedWorkflowId === null;
    if (draft.mode === 'workflow') {
      definition = readDraftDefinition(layout);
      if (draft.savedWorkflowId === null) assertNewWorkflow(db, definition);
      else {
        // 再次保存：在已保存的 workflow 下建新 variant，定义必须没有改动
        const saved = loadWorkflow(db, draft.savedWorkflowId);
        if (!isDeepStrictEqual(saved, definition)) {
          throw new HttpError(
            400,
            `workflow.yaml 与已保存的 workflow ${saved.id} 的定义不同；要改定义就在 Workflow 页面改，或另开草稿。\n已保存：\n${stringify(saved)}\nworkflow.yaml：\n${stringify(definition)}`,
          );
        }
      }
    } else {
      definition = loadWorkflow(db, draft.workflowId);
    }
    checkDraftSkills(layout, definition);
    if (newWorkflow) insertWorkflow(db, definition, base.workflowId);
    const variant = variants.createFromDraft({
      srcDir: layout.src,
      workflowId: definition.id,
      name: newWorkflow ? '基线' : variants.freeName(definition.id, `Codex ${id}`),
      parentId: base.id,
      draftId: id,
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
