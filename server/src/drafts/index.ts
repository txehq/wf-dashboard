import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { asc, eq } from 'drizzle-orm';
import { stringify } from 'yaml';
import type { CodexSkillSources } from '../config.js';
import type { Db } from '../db/index.js';
import { variants as variantsTable, workflowDrafts } from '../db/schema.js';
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
import { draftLayout, initialMessage, prepareDraftDir } from './dir.js';
import { installCodexSkills } from './skills.js';
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

// 用 Codex 生成 workflow 或 variant（Contracts 第 17 节）
export function createDrafts({ db, variants, live, draftsDir, skillSources }: DraftsDeps) {
  // 正在保存的草稿：同一草稿同时只保存一次
  const saving = new Set<string>();

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
      baseVariantId: r.baseVariantId,
      requirement: r.requirement,
      liveId: r.liveId,
      status: r.status,
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

  // 建草稿与草稿目录（不安装 skill，不启动 Codex）。mode 为 workflow 时 workflow.yaml 先填 id、名字与底子的小阶段
  function open(body: CreateDraftBody): DraftView {
    const base = variants.get(body.baseVariantId);
    let definition: WorkflowDefinition;
    if (body.mode === 'workflow') {
      definition = parseDefinition(
        {
          id: body.workflowId,
          name: body.name,
          stages: loadWorkflow(db, base.workflowId).stages,
        },
        `新 workflow ${body.workflowId} 的定义`,
      );
      assertNewWorkflow(db, definition);
    } else {
      definition = loadWorkflow(db, body.workflowId);
      if (base.workflowId !== body.workflowId) {
        throw new HttpError(
          400,
          `底子 variant ${base.name} 属于 workflow ${base.workflowId}，不是 ${body.workflowId} 的 variant`,
        );
      }
    }
    const id = newId('d');
    prepareDraftDir(layoutOf(id).dir, {
      mode: body.mode,
      definition,
      copySource: (dest) => {
        variants.exportSource(base.id, dest);
      },
    });
    db.insert(workflowDrafts)
      .values({
        id,
        mode: body.mode,
        workflowId: body.workflowId,
        baseVariantId: base.id,
        requirement: body.requirement,
      })
      .run();
    return view(row(id));
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
        throw new HttpError(
          400,
          `构建失败：${error instanceof Error ? error.message : String(error)}\n${log}`,
        );
      },
    );
    db.update(workflowDrafts)
      .set({ status: 'saved', savedWorkflowId: definition.id, savedVariantId: variant.id })
      .where(eq(workflowDrafts.id, id))
      .run();
    return view(row(id));
  }

  return {
    get: (id: string) => view(row(id)),

    open,

    // 发起（Contracts 17.1）：草稿目录、装 skill（版本记进草稿）、在 Live 中建 Codex 会话
    async create(body: CreateDraftBody): Promise<{ draft: DraftView; live: LiveDetail }> {
      const draft = open(body);
      const layout = layoutOf(draft.id);
      const skills = await installCodexSkills(layout, skillSources);
      db.update(workflowDrafts).set({ skills }).where(eq(workflowDrafts.id, draft.id)).run();
      const detail = await live.createCodex({
        cwd: layout.dir,
        prompt: initialMessage(body.mode, body.requirement),
        title:
          body.mode === 'workflow'
            ? `Codex：新 workflow ${body.workflowId}`
            : `Codex：${body.workflowId} 的新 variant`,
        workflow: body.mode === 'workflow' ? null : body.workflowId,
      });
      db.update(workflowDrafts)
        .set({ liveId: detail.id })
        .where(eq(workflowDrafts.id, draft.id))
        .run();
      events.publish({ type: 'live.updated', liveId: detail.id });
      return { draft: view(row(draft.id)), live: live.get(detail.id) };
    },

    // 保存（Contracts 17.4）：同一草稿同时只保存一次
    async save(id: string): Promise<DraftView> {
      row(id);
      if (saving.has(id)) throw new HttpError(409, `草稿 ${id} 正在保存`);
      saving.add(id);
      return saveDraft(id).finally(() => {
        saving.delete(id);
      });
    },
  };
}

export type Drafts = ReturnType<typeof createDrafts>;
