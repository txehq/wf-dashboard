import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import { parse } from 'yaml';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import { variants, workflowTable } from '../db/schema.js';
import { HttpError } from '../variants/errors.js';
import type { Variants } from '../variants/index.js';
import {
  type BigStageDefinition,
  bigStageOf,
  DEV_WORKFLOW_ID,
  taskFieldsOf,
  WorkflowDefinition,
  type WorkflowView,
} from './schema.js';

// pnpm start 运行 dist 时同样从源码目录读取
const DEV_WORKFLOW_FILE = path.join(config.repoRoot, 'server/src/workflows/dev-workflow.yaml');

type WorkflowRow = typeof workflowTable.$inferSelect;

// 定义不符合 schema 时以 zod 的原文失败
export function parseDefinition(value: unknown, where: string): WorkflowDefinition {
  const result = WorkflowDefinition.safeParse(value);
  if (!result.success)
    throw new HttpError(400, `${where} 不符合 workflow schema：${result.error.message}`);
  return result.data;
}

export function builtinDefinition(): WorkflowDefinition {
  return parseDefinition(parse(fs.readFileSync(DEV_WORKFLOW_FILE, 'utf8')), DEV_WORKFLOW_FILE);
}

// 阶段划分的增量状态据此判断定义是否改变
export function definitionHash(definition: WorkflowDefinition): string {
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex');
}

// 服务启动时（打开数据库后）以内置 YAML 为准写入 dev-workflow；底子为最早导入的基线 variant
// （有安装目录的优先：从其他数据目录导入的 variant 只有 skill 内容）
export function syncBuiltinWorkflows(db: Db) {
  const definition = builtinDefinition();
  const base = db
    .select({ id: variants.id })
    .from(variants)
    .where(and(eq(variants.workflowId, DEV_WORKFLOW_ID), isNull(variants.parentId)))
    .orderBy(sql`${variants.installDir} is null`, asc(variants.createdAt), asc(variants.id))
    .get();
  const existing = db
    .select()
    .from(workflowTable)
    .where(eq(workflowTable.id, DEV_WORKFLOW_ID))
    .get();
  const baseVariantId = existing?.baseVariantId ?? base?.id ?? null;
  if (
    existing?.baseVariantId === baseVariantId &&
    JSON.stringify(existing.definition) === JSON.stringify(definition)
  )
    return;
  const values = { name: definition.name, baseVariantId, definition, updatedAt: new Date() };
  db.insert(workflowTable)
    .values({ id: DEV_WORKFLOW_ID, ...values })
    .onConflictDoUpdate({ target: workflowTable.id, set: values })
    .run();
}

function row(db: Db, id: string): WorkflowRow {
  const found = db.select().from(workflowTable).where(eq(workflowTable.id, id)).get();
  if (found === undefined) throw new HttpError(404, `没有 workflow ${id}`);
  return found;
}

export function loadWorkflow(db: Db, id: string): WorkflowDefinition {
  return parseDefinition(row(db, id).definition, `workflow ${id}`);
}

export function loadBigStage(db: Db, workflowId: string, bigStage: string): BigStageDefinition {
  return bigStageOf(loadWorkflow(db, workflowId), bigStage);
}

export function workflowOfVariant(db: Db, variantId: string): string {
  const v = db
    .select({ workflowId: variants.workflowId })
    .from(variants)
    .where(eq(variants.id, variantId))
    .get();
  if (v === undefined) throw new Error(`variant ${variantId} 不存在`);
  return v.workflowId;
}

function view(db: Db, r: WorkflowRow): WorkflowView {
  const definition = parseDefinition(r.definition, `workflow ${r.id}`);
  const n = db.select({ n: count() }).from(variants).where(eq(variants.workflowId, r.id)).get();
  return {
    id: r.id,
    name: r.name,
    baseVariantId: r.baseVariantId,
    builtin: r.id === DEV_WORKFLOW_ID,
    definition,
    taskFields: Object.fromEntries(definition.bigStages.map((s) => [s.id, taskFieldsOf(s)])),
    variants: n?.n ?? 0,
    createdAt: r.createdAt.getTime(),
    updatedAt: r.updatedAt.getTime(),
  };
}

export interface NewWorkflow {
  id: string;
  name: string;
  // 作底子的 variant：复制它的基线导出与 src/skills
  variantId: string;
  // 完整定义，按 WorkflowDefinition 校验
  definition: unknown;
}

// Contracts 16.1 的 API 背后的服务
export function createWorkflows({ db, variants: variantsModule }: { db: Db; variants: Variants }) {
  function create(input: NewWorkflow): WorkflowView {
    const definition = parseDefinition(input.definition, `workflow ${input.id} 的定义`);
    if (definition.id !== input.id || definition.name !== input.name) {
      throw new HttpError(
        400,
        `定义中的 id、name（${definition.id}、${definition.name}）与请求（${input.id}、${input.name}）不一致`,
      );
    }
    if (db.select().from(workflowTable).where(eq(workflowTable.id, input.id)).get()) {
      throw new HttpError(409, `workflow ${input.id} 已存在`);
    }
    variantsModule.get(input.variantId);
    // 先写 workflow 行（base 为空），再复制 variant：variant 的 workflow 必须已存在
    db.insert(workflowTable)
      .values({ id: input.id, name: input.name, definition, updatedAt: new Date() })
      .run();
    const base = variantsModule.copyToWorkflow(input.variantId, {
      workflowId: input.id,
      name: '基线',
    });
    db.update(workflowTable)
      .set({ baseVariantId: base.id })
      .where(eq(workflowTable.id, input.id))
      .run();
    return view(db, row(db, input.id));
  }

  return {
    list(): WorkflowView[] {
      return db
        .select()
        .from(workflowTable)
        .orderBy(asc(workflowTable.createdAt), asc(workflowTable.id))
        .all()
        .map((r) => view(db, r));
    },

    get(id: string): WorkflowView {
      return view(db, row(db, id));
    },

    create,

    // 从 variant 复制成新 workflow：定义先复制 :id 的定义，换掉 id 与 name
    copy(sourceId: string, input: { variantId: string; id: string; name: string }): WorkflowView {
      const source = loadWorkflow(db, sourceId);
      return create({ ...input, definition: { ...source, id: input.id, name: input.name } });
    },

    update(id: string, input: { definition: unknown }): WorkflowView {
      if (id === DEV_WORKFLOW_ID) {
        throw new HttpError(409, 'dev-workflow 是内置的，不能修改；要改就复制成新 workflow');
      }
      row(db, id);
      const definition = parseDefinition(input.definition, `workflow ${id} 的定义`);
      if (definition.id !== id) {
        throw new HttpError(400, `定义中的 id ${definition.id} 与路径 ${id} 不一致`);
      }
      db.update(workflowTable)
        .set({ name: definition.name, definition, updatedAt: new Date() })
        .where(eq(workflowTable.id, id))
        .run();
      return view(db, row(db, id));
    },
  };
}

export type Workflows = ReturnType<typeof createWorkflows>;
