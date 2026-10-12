import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { asc, count, eq } from 'drizzle-orm';
import { parse } from 'yaml';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import { variants, workflowTable } from '../db/schema.js';
import { HttpError } from '../variants/errors.js';
import type { Variants } from '../variants/index.js';
import { evalSpec } from './eval-kinds.js';
import {
  BUILTIN_WORKFLOWS,
  type EvalKind,
  type EvalSpec,
  isBuiltinWorkflow,
  type NewWorkflowBody,
  type UpdateWorkflowBody,
  WorkflowDefinition,
  type WorkflowView,
} from './schema.js';

// pnpm start 运行 dist 时同样从源码目录读取
const builtinFile = (id: EvalKind) => path.join(config.repoRoot, `server/src/workflows/${id}.yaml`);

type WorkflowRow = typeof workflowTable.$inferSelect;

// 定义不符合 schema 时以 zod 的原文失败
export function parseDefinition(value: unknown, where: string): WorkflowDefinition {
  const result = WorkflowDefinition.safeParse(value);
  if (!result.success)
    throw new HttpError(400, `${where} 不符合 workflow schema：${result.error.message}`);
  return result.data;
}

export function builtinDefinition(id: EvalKind): WorkflowDefinition {
  const file = builtinFile(id);
  const definition = parseDefinition(parse(fs.readFileSync(file, 'utf8')), file);
  if (definition.id !== id) throw new Error(`${file} 的 id 应为 ${id}：${definition.id}`);
  return definition;
}

// 阶段划分的增量状态据此判断定义是否改变
export function definitionHash(definition: WorkflowDefinition): string {
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex');
}

// 服务启动时（打开数据库后）以内置 YAML 为准写入 lfg 与 ic，评测类型与 id 同名
export function syncBuiltinWorkflows(db: Db) {
  for (const id of BUILTIN_WORKFLOWS) {
    const definition = builtinDefinition(id);
    const existing = db.select().from(workflowTable).where(eq(workflowTable.id, id)).get();
    if (
      existing?.evalKind === id &&
      JSON.stringify(existing.definition) === JSON.stringify(definition)
    )
      continue;
    const values = { name: definition.name, evalKind: id, definition, updatedAt: new Date() };
    db.insert(workflowTable)
      .values({ id, ...values })
      .onConflictDoUpdate({ target: workflowTable.id, set: values })
      .run();
  }
}

export function workflowRow(db: Db, id: string): WorkflowRow {
  const found = db.select().from(workflowTable).where(eq(workflowTable.id, id)).get();
  if (found === undefined) throw new HttpError(404, `没有 workflow ${id}`);
  return found;
}

export function loadWorkflow(db: Db, id: string): WorkflowDefinition {
  return parseDefinition(workflowRow(db, id).definition, `workflow ${id}`);
}

// 有评测类型的 workflow 运行时取用的配置（16.2）；没有评测类型时 400 原文
export function evalSpecOf(db: Db, workflowId: string): EvalSpec {
  const r = workflowRow(db, workflowId);
  if (r.evalKind === null) {
    throw new HttpError(
      400,
      `workflow ${workflowId} 没有评测类型，不能评测（只用于 Live、阶段划分与分析）`,
    );
  }
  return evalSpec(r.evalKind, r.id);
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
  const n = db.select({ n: count() }).from(variants).where(eq(variants.workflowId, r.id)).get();
  return {
    id: r.id,
    name: r.name,
    evalKind: r.evalKind,
    copiedFrom: r.copiedFrom,
    builtin: isBuiltinWorkflow(r.id),
    definition: parseDefinition(r.definition, `workflow ${r.id}`),
    variants: n?.n ?? 0,
    createdAt: r.createdAt.getTime(),
    updatedAt: r.updatedAt.getTime(),
  };
}

// 定义中的 id、name 必须与请求一致
function checkedDefinition(value: unknown, id: string, name: string): WorkflowDefinition {
  const definition = parseDefinition(value, `workflow ${id} 的定义`);
  if (definition.id !== id || definition.name !== name) {
    throw new HttpError(
      400,
      `定义中的 id、name（${definition.id}、${definition.name}）与请求（${id}、${name}）不一致`,
    );
  }
  return definition;
}

// workflow id 是入口命令，也不能与任何 workflow 的小阶段同名（否则 Skill 调用无法区分是哪一个）
function assertEntryFree(db: Db, definition: WorkflowDefinition) {
  for (const r of db.select().from(workflowTable).all()) {
    if (r.id === definition.id) continue;
    const other = parseDefinition(r.definition, `workflow ${r.id}`);
    if (other.stages.some((s) => s.id === definition.id)) {
      throw new HttpError(400, `workflow id ${definition.id} 与 workflow ${r.id} 的小阶段同名`);
    }
  }
}

// Codex 草稿保存为新 workflow（Contracts 17.4）：id 未被使用、不与其他 workflow 的小阶段同名
export function assertNewWorkflow(db: Db, definition: WorkflowDefinition) {
  if (db.select().from(workflowTable).where(eq(workflowTable.id, definition.id)).get()) {
    throw new HttpError(400, `workflow id ${definition.id} 已被使用`);
  }
  assertEntryFree(db, definition);
}

// 没有评测类型的新 workflow；copiedFrom 为底子 variant 所属的 workflow
export function insertWorkflow(db: Db, definition: WorkflowDefinition, copiedFrom: string) {
  assertNewWorkflow(db, definition);
  db.insert(workflowTable)
    .values({
      id: definition.id,
      name: definition.name,
      evalKind: null,
      definition,
      copiedFrom,
      updatedAt: new Date(),
    })
    .run();
}

// 保存草稿时构建失败：删去这次建出、还没有 variant 的 workflow
export function deleteEmptyWorkflow(db: Db, id: string) {
  const n = db.select({ n: count() }).from(variants).where(eq(variants.workflowId, id)).get();
  if ((n?.n ?? 0) > 0) throw new Error(`workflow ${id} 还有 variant，不能删除`);
  db.delete(workflowTable).where(eq(workflowTable.id, id)).run();
}

// Contracts 16.1 的 API 背后的服务
export function createWorkflows({ db, variants: variantsModule }: { db: Db; variants: Variants }) {
  return {
    // 内置的 lfg、ic 在前，其余按创建顺序
    list(): WorkflowView[] {
      const order = (id: string) => {
        const i = (BUILTIN_WORKFLOWS as readonly string[]).indexOf(id);
        return i === -1 ? BUILTIN_WORKFLOWS.length : i;
      };
      return db
        .select()
        .from(workflowTable)
        .orderBy(asc(workflowTable.createdAt), asc(workflowTable.id))
        .all()
        .sort((a, b) => order(a.id) - order(b.id))
        .map((r) => view(db, r));
    },

    get(id: string): WorkflowView {
      return view(db, workflowRow(db, id));
    },

    // 复制 fromVariantId 的基线导出与 src/skills，作为新 workflow 的第一个 variant（草稿，名字"基线"）
    create(input: NewWorkflowBody): WorkflowView {
      const definition = checkedDefinition(input.definition, input.id, input.name);
      if (db.select().from(workflowTable).where(eq(workflowTable.id, input.id)).get()) {
        throw new HttpError(409, `workflow ${input.id} 已存在`);
      }
      assertEntryFree(db, definition);
      const source = variantsModule.get(input.fromVariantId);
      const from = workflowRow(db, source.workflowId);
      // 先写 workflow 行，再复制 variant：variant 的 workflow 必须已存在
      db.insert(workflowTable)
        .values({
          id: input.id,
          name: input.name,
          evalKind: input.keepEvalKind ? from.evalKind : null,
          definition,
          copiedFrom: from.id,
          updatedAt: new Date(),
        })
        .run();
      variantsModule.copyToWorkflow(source.id, { workflowId: input.id, name: '基线' });
      return view(db, workflowRow(db, input.id));
    },

    // 名字与定义可改，评测类型不能改；内置的两个返回 409
    update(id: string, input: UpdateWorkflowBody): WorkflowView {
      if (isBuiltinWorkflow(id)) {
        throw new HttpError(409, `${id} 是内置的 workflow，不能修改；要改就复制成新 workflow`);
      }
      workflowRow(db, id);
      const definition = checkedDefinition(input.definition, id, input.name);
      db.update(workflowTable)
        .set({ name: definition.name, definition, updatedAt: new Date() })
        .where(eq(workflowTable.id, id))
        .run();
      return view(db, workflowRow(db, id));
    },
  };
}

export type Workflows = ReturnType<typeof createWorkflows>;
