import fs from 'node:fs';
import path from 'node:path';
import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  analyses,
  liveProcesses,
  liveSessions,
  runs,
  sessions,
  variants as variantsTable,
  workflowDrafts,
  workflowTable,
} from '../db/schema.js';
import { draftLayout } from '../drafts/dir.js';
import { events } from '../events.js';
import { analysisLayout } from '../insights/index.js';
import type { Live } from '../live/index.js';
import { HttpError } from '../variants/errors.js';
import type { Variant, Variants } from '../variants/index.js';
import { workflowRow } from '../workflows/index.js';
import { isBuiltinWorkflow } from '../workflows/schema.js';
import type { DeleteBody, DeletionBlocker, DeletionPlan, SessionsChoice } from './views.js';

export interface DeletionDeps {
  db: Db;
  variants: Variants;
  live: Live;
  // data/workflow-drafts
  draftsDir: string;
  // 数据目录：优化草稿的目录是其中的 analyses/<id>/
  dataDir: string;
}

const ACTIVE_RUNS = ['queued', 'preparing', 'running', 'grading'] as const;
const ACTIVE_ANALYSES = ['queued', 'running'] as const;

type DraftRow = typeof workflowDrafts.$inferSelect;

// 删除 variant 与 workflow（Contracts 第 24 节）：能否删除、关联 session 的两种处理、保留的记录、删除的文件
export function createDeletion({ db, variants, live, draftsDir, dataDir }: DeletionDeps) {
  // 关联的 session（24.2）：绑定到这些 variant、不是 run 的 session
  function boundSessions(ids: string[]) {
    if (ids.length === 0) return [];
    return db
      .select()
      .from(sessions)
      .where(
        and(
          inArray(sessions.variantId, ids),
          or(isNull(sessions.variantBinding), ne(sessions.variantBinding, 'run')),
        ),
      )
      .all();
  }

  // 一个 session 在磁盘上的原始文件：主 jsonl 与同名的子代理、tool-results 目录
  function sessionFiles(s: typeof sessions.$inferSelect): string[] {
    const dir = path.join(path.dirname(s.filePath), s.id);
    return [s.filePath, dir].filter((f) => fs.existsSync(f));
  }

  // 草稿要删的目录：普通草稿是整个草稿目录；优化草稿的目录是分析目录（分析保留），只删优化用的部分
  function draftDirs(d: DraftRow): string[] {
    if (d.analysisId === null) return [path.join(draftsDir, d.id)];
    const layout = draftLayout(analysisLayout(dataDir, d.analysisId).dir, 'optimize');
    return [
      path.dirname(layout.src),
      layout.codexHome,
      layout.home,
      layout.claudeDir,
      path.dirname(layout.agentSkills),
      path.dirname(layout.claudeSkills),
      layout.skillsLock,
      layout.platform,
      path.dirname(layout.example),
    ];
  }

  // 运行中的使用者（24.1）：进行中的 run、运行中的交互进程、进行中的分析、正在准备或有运行中进程的草稿
  function activeUsers(ids: string[], drafts: DraftRow[]): DeletionBlocker[] {
    const blockers: DeletionBlocker[] = [];
    if (ids.length > 0) {
      for (const r of db
        .select({ id: runs.id, status: runs.status })
        .from(runs)
        .where(and(inArray(runs.variantId, ids), inArray(runs.status, ACTIVE_RUNS)))
        .all()) {
        blockers.push({ kind: 'run', id: r.id, label: `run ${r.id}（${r.status}）` });
      }
      for (const p of db
        .select({ liveId: liveProcesses.liveId, title: liveSessions.title })
        .from(liveProcesses)
        .innerJoin(liveSessions, eq(liveSessions.id, liveProcesses.liveId))
        .where(and(inArray(liveProcesses.variantId, ids), eq(liveProcesses.status, 'running')))
        .all()) {
        blockers.push({ kind: 'live', id: p.liveId, label: `交互 ${p.title}（运行中）` });
      }
      for (const a of db
        .select({ id: analyses.id, status: analyses.status })
        .from(analyses)
        .where(
          and(
            or(inArray(analyses.variantId, ids), inArray(analyses.analysisVariantId, ids)),
            inArray(analyses.status, ACTIVE_ANALYSES),
          ),
        )
        .all()) {
        blockers.push({ kind: 'analysis', id: a.id, label: `分析 ${a.id}（${a.status}）` });
      }
    }
    for (const d of drafts) {
      const running =
        d.liveId !== null &&
        db
          .select({ id: liveProcesses.id })
          .from(liveProcesses)
          .where(and(eq(liveProcesses.liveId, d.liveId), eq(liveProcesses.status, 'running')))
          .get() !== undefined;
      if (d.status === 'preparing' || (d.status === 'open' && running)) {
        blockers.push({
          kind: 'draft',
          id: d.id,
          label: `草稿 ${d.id}（${d.status === 'preparing' ? '正在准备' : '会话运行中'}）`,
        });
      }
    }
    return blockers;
  }

  // 用到这些 variant 的草稿（底子是它们）；删除 workflow 时另加属于它的草稿
  function draftsUsing(ids: string[], workflowId: string | null): DraftRow[] {
    const conditions = [
      ...(ids.length > 0 ? [inArray(workflowDrafts.baseVariantId, ids)] : []),
      ...(workflowId === null ? [] : [eq(workflowDrafts.workflowId, workflowId)]),
    ];
    if (conditions.length === 0) return [];
    return db
      .select()
      .from(workflowDrafts)
      .where(or(...conditions))
      .all();
  }

  function plan(
    target: DeletionPlan['target'],
    rows: Variant[],
    workflowId: string | null,
    blockers: DeletionBlocker[],
  ): DeletionPlan {
    const ids = rows.map((v) => v.id);
    const relatedDrafts = draftsUsing(ids, workflowId);
    // 删除 workflow 时属于它的草稿一并删除；只删 variant 时草稿保留
    const removedDrafts = workflowId === null ? [] : relatedDrafts;
    const bound = boundSessions(ids);
    const sessionLiveIds = [
      ...new Set(bound.flatMap((s) => (s.liveId === null ? [] : [s.liveId]))),
    ];
    const liveItems = sessionLiveIds.map((id) => {
      const item = db.select().from(liveSessions).where(eq(liveSessions.id, id)).get();
      if (item === undefined) throw new Error(`session 指向的交互项不存在：${id}`);
      return { id, title: item.title };
    });
    const installs = variants.installsOf(ids);
    for (const i of installs) {
      if (i.modified.length > 0) {
        blockers.push({
          kind: 'install',
          id: i.variantId,
          label: `装在本机的 skill 在安装后被改过，卸载会被拒绝：${i.modified.join('、')}`,
        });
      }
    }
    // 保留的 Live 项：用过这些 variant 的进程所在的项，减去随 session 一起删除的
    const usedLive =
      ids.length === 0
        ? []
        : db
            .selectDistinct({ liveId: liveProcesses.liveId })
            .from(liveProcesses)
            .where(inArray(liveProcesses.variantId, ids))
            .all()
            .map((p) => p.liveId);
    const runSessions =
      ids.length === 0
        ? 0
        : db
            .select({ id: sessions.id })
            .from(sessions)
            .where(and(inArray(sessions.variantId, ids), eq(sessions.variantBinding, 'run')))
            .all().length;
    const removing = new Set(ids);
    return {
      target,
      variants: rows.map((v) => ({ id: v.id, name: v.name })),
      blockers: [...blockers, ...activeUsers(ids, relatedDrafts)],
      dirs: [
        ...variants.deletionDirs(ids),
        ...removedDrafts.flatMap(draftDirs).filter((d) => fs.existsSync(d)),
      ],
      installs: installs.map((i) => ({ variantId: i.variantId, dirs: i.manifest.dirs })),
      sessions: { count: bound.length, files: bound.flatMap(sessionFiles), liveItems },
      retained: {
        runs:
          ids.length === 0
            ? 0
            : db.select({ id: runs.id }).from(runs).where(inArray(runs.variantId, ids)).all()
                .length,
        runSessions,
        analyses:
          ids.length === 0
            ? 0
            : db
                .select({ id: analyses.id })
                .from(analyses)
                .where(
                  or(inArray(analyses.variantId, ids), inArray(analyses.analysisVariantId, ids)),
                )
                .all().length,
        liveItems: usedLive.filter((id) => !sessionLiveIds.includes(id)).length,
        children:
          ids.length === 0
            ? []
            : db
                .select({ id: variantsTable.id, name: variantsTable.name })
                .from(variantsTable)
                .where(and(inArray(variantsTable.parentId, ids), isNull(variantsTable.deletedAt)))
                .all()
                .filter((v) => !removing.has(v.id)),
        drafts: relatedDrafts.length - removedDrafts.length,
      },
      drafts: removedDrafts.map((d) => ({ id: d.id, liveId: d.liveId })),
    };
  }

  function variantPlan(id: string): DeletionPlan {
    const row = variants.get(id);
    const blockers: DeletionBlocker[] = [];
    const siblings = variants.list().filter((v) => v.workflowId === row.workflowId);
    if (siblings.length <= 1) {
      blockers.push({
        kind: 'last-variant',
        id: row.workflowId,
        label: `${row.name} 是 workflow ${row.workflowId} 的最后一个 variant，不能单独删除；要删就删除 workflow`,
      });
    }
    return plan(
      { kind: 'variant', id, name: row.name, workflowId: row.workflowId },
      [row],
      null,
      blockers,
    );
  }

  function workflowPlan(id: string): DeletionPlan {
    const w = workflowRow(db, id);
    const blockers: DeletionBlocker[] = [];
    if (isBuiltinWorkflow(id)) {
      blockers.push({ kind: 'builtin', id, label: `${id} 是内置的 workflow，不能删除` });
    }
    const rows = variants.list().filter((v) => v.workflowId === id);
    return plan({ kind: 'workflow', id, name: w.name, workflowId: id }, rows, id, blockers);
  }

  // 改绑的目标（24.2）：本机配置（null），或没有删除、不在这次删除之内的任何 variant
  function rebindTarget(choice: SessionsChoice, p: DeletionPlan): string | null {
    if (choice === 'delete' || choice.rebindTo === null) return null;
    const target = variants.get(choice.rebindTo);
    if (p.variants.some((v) => v.id === target.id)) {
      throw new HttpError(400, `不能改绑到要删除的 variant ${target.name}`);
    }
    return target.id;
  }

  function execute(p: DeletionPlan, body: DeleteBody) {
    const subject = `${p.target.kind} ${p.target.name}`;
    if (p.blockers.length > 0) {
      throw new HttpError(
        409,
        `不能删除 ${subject}：\n${p.blockers.map((b) => `- ${b.label}`).join('\n')}`,
      );
    }
    const ids = p.variants.map((v) => v.id);
    const rebindTo = rebindTarget(body.sessions, p);
    const bound = boundSessions(ids);
    // 一起删除的 Live 项要先结束进程：在改动任何东西之前检查
    const liveToRemove = [
      ...new Set([
        ...(body.sessions === 'delete' ? p.sessions.liveItems.map((i) => i.id) : []),
        ...p.drafts.flatMap((d) => (d.liveId === null ? [] : [d.liveId])),
      ]),
    ];
    const runningItems = liveToRemove.filter(
      (id) =>
        db
          .select({ id: liveProcesses.id })
          .from(liveProcesses)
          .where(and(eq(liveProcesses.liveId, id), eq(liveProcesses.status, 'running')))
          .get() !== undefined,
    );
    if (runningItems.length > 0) {
      throw new HttpError(
        409,
        `不能删除 ${subject}：要一起删除的交互项有运行中的进程，先结束进程：${runningItems.join('、')}`,
      );
    }
    // 1. 本机安装先卸载：被改过时拒绝，什么都还没有改
    variants.removeFiles(ids, []);
    // 2. 关联的 session：一起删除（连同 Live 项与磁盘上的原始文件），或改绑；
    // 3. 删除 workflow 时属于它的草稿的 Live 项
    for (const id of liveToRemove) live.removeItem(id);
    if (body.sessions === 'delete') {
      const files = bound.flatMap(sessionFiles);
      if (bound.length > 0) {
        db.delete(sessions)
          .where(
            inArray(
              sessions.id,
              bound.map((s) => s.id),
            ),
          )
          .run();
      }
      for (const f of files) fs.rmSync(f, { recursive: true, force: true });
    } else if (bound.length > 0) {
      db.update(sessions)
        .set({ variantId: rebindTo, variantBinding: 'manual' })
        .where(
          inArray(
            sessions.id,
            bound.map((s) => s.id),
          ),
        )
        .run();
    }
    const at = new Date();
    db.$client.transaction(() => {
      if (p.drafts.length > 0) {
        db.delete(workflowDrafts)
          .where(
            inArray(
              workflowDrafts.id,
              p.drafts.map((d) => d.id),
            ),
          )
          .run();
      }
      // 4. 保留一行记录，只用于显示名字
      variants.markDeleted(ids, at);
      if (p.target.kind === 'workflow') {
        db.update(workflowTable)
          .set({ deletedAt: at })
          .where(eq(workflowTable.id, p.target.id))
          .run();
      }
    })();
    // 5. 文件：variant 的目录与存档（共用的最后一个引用删除时才删）、草稿目录
    variants.removeFiles([], p.dirs);
    console.info(
      `[delete] ${subject}：variant ${ids.join(', ')}；session ${String(bound.length)} 个${body.sessions === 'delete' ? '一起删除' : `改绑到 ${rebindTo ?? '本机配置'}`}；目录 ${p.dirs.join(', ')}`,
    );
    for (const id of ids) events.publish({ type: 'variant.deleted', variantId: id });
    if (p.target.kind === 'workflow') {
      events.publish({ type: 'workflow.deleted', workflowId: p.target.id });
    }
    for (const s of bound) events.publish({ type: 'session.updated', sessionId: s.id });
  }

  return {
    variantPlan,
    workflowPlan,

    deleteVariant(id: string, body: DeleteBody): DeletionPlan {
      const p = variantPlan(id);
      execute(p, body);
      return p;
    },

    deleteWorkflow(id: string, body: DeleteBody): DeletionPlan {
      const p = workflowPlan(id);
      execute(p, body);
      return p;
    },
  };
}

export type Deletion = ReturnType<typeof createDeletion>;
