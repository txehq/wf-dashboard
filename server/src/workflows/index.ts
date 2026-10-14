import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, asc, count, eq, isNull } from 'drizzle-orm';
import { parse } from 'yaml';
import { z } from 'zod';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import { variants, workflowTable } from '../db/schema.js';
import { HttpError } from '../variants/errors.js';
import type { Variants } from '../variants/index.js';
import { evalSpec } from './eval-kinds.js';
import {
  BUILTIN_WORKFLOWS,
  type BuiltinWorkflow,
  type EvalSpec,
  isBuiltinWorkflow,
  isWfWorkflow,
  type NewWorkflowBody,
  type UpdateWorkflowBody,
  WorkflowDefinition,
  type WorkflowView,
} from './schema.js';

// pnpm start 运行 dist 时同样从源码目录读取
const builtinFile = (id: BuiltinWorkflow) =>
  path.join(config.repoRoot, `server/src/workflows/${id}.yaml`);

// session-analysis 基线 variant 的 skill（Contracts 19.2）：src/ 的形状，skills/ 在其下
export const analysisBaselineSrc = path.join(
  config.repoRoot,
  'server/src/workflows/session-analysis',
);

type WorkflowRow = typeof workflowTable.$inferSelect;

// 定义不符合 schema 时以 zod 的原文失败
export function parseDefinition(value: unknown, where: string): WorkflowDefinition {
  const result = WorkflowDefinition.safeParse(value);
  if (!result.success)
    throw new HttpError(400, `${where} 不符合 workflow schema：${result.error.message}`);
  return result.data;
}

const BuiltinFile = z.looseObject({ description: z.string().trim().min(1) });

// 内置 yaml 的 description 不属于定义（Contracts 18.3），其余部分是定义
function readBuiltin(id: BuiltinWorkflow): { definition: WorkflowDefinition; description: string } {
  const file = builtinFile(id);
  const { description, ...rest } = BuiltinFile.parse(parse(fs.readFileSync(file, 'utf8')));
  const definition = parseDefinition(rest, file);
  if (definition.id !== id) throw new Error(`${file} 的 id 应为 ${id}：${definition.id}`);
  return { definition, description };
}

export function builtinDefinition(id: BuiltinWorkflow): WorkflowDefinition {
  return readBuiltin(id).definition;
}

// 阶段划分的增量状态据此判断定义是否改变
export function definitionHash(definition: WorkflowDefinition): string {
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex');
}

// 服务启动时（打开数据库后）以内置 YAML 为准写入 lfg、ic 与 session-analysis：lfg、ic 的评测类型与 id 同名，
// session-analysis 没有评测类型（Contracts 19.2）。描述只在还没有时取 yaml 中的（之后在页面中编辑，Contracts 18.3）
export function syncBuiltinWorkflows(db: Db) {
  for (const id of BUILTIN_WORKFLOWS) {
    const { definition, description } = readBuiltin(id);
    const evalKind = isWfWorkflow(id) ? id : null;
    const existing = db.select().from(workflowTable).where(eq(workflowTable.id, id)).get();
    if (
      existing?.evalKind === evalKind &&
      existing.description !== null &&
      JSON.stringify(existing.definition) === JSON.stringify(definition)
    )
      continue;
    const values = {
      name: definition.name,
      evalKind,
      definition,
      description: existing?.description ?? description,
      updatedAt: new Date(),
    };
    db.insert(workflowTable)
      .values({ id, ...values })
      .onConflictDoUpdate({ target: workflowTable.id, set: values })
      .run();
  }
}

// 包括已删除的 workflow：只用于显示名字（Contracts 24.5）
export function workflowRecord(db: Db, id: string): WorkflowRow {
  const found = db.select().from(workflowTable).where(eq(workflowTable.id, id)).get();
  if (found === undefined) throw new HttpError(404, `没有 workflow ${id}`);
  return found;
}

// 已删除的 workflow 不能再使用
export function workflowRow(db: Db, id: string): WorkflowRow {
  const found = workflowRecord(db, id);
  if (found.deletedAt !== null) throw new HttpError(404, `workflow ${id} 已删除`);
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
  const n = db
    .select({ n: count() })
    .from(variants)
    .where(and(eq(variants.workflowId, r.id), isNull(variants.deletedAt)))
    .get();
  return {
    id: r.id,
    name: r.name,
    evalKind: r.evalKind,
    description: r.description,
    builtin: isBuiltinWorkflow(r.id),
    wf: isWfWorkflow(r.id),
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
  for (const r of db.select().from(workflowTable).where(isNull(workflowTable.deletedAt)).all()) {
    if (r.id === definition.id) continue;
    const other = parseDefinition(r.definition, `workflow ${r.id}`);
    if (other.stages.some((s) => s.id === definition.id)) {
      throw new HttpError(400, `workflow id ${definition.id} 与 workflow ${r.id} 的小阶段同名`);
    }
  }
}

// Codex 草稿保存为新 workflow（Contracts 17.4）：id 未被使用、不与其他 workflow 的小阶段同名
export function assertNewWorkflow(db: Db, definition: WorkflowDefinition) {
  const existing = db.select().from(workflowTable).where(eq(workflowTable.id, definition.id)).get();
  if (existing !== undefined) {
    throw new HttpError(
      400,
      existing.deletedAt === null
        ? `workflow id ${definition.id} 已被使用`
        : `workflow id ${definition.id} 已被使用：已删除的 workflow ${existing.name} 保留这个 id，换一个 id`,
    );
  }
  assertEntryFree(db, definition);
}

// 没有评测类型的新 workflow（Contracts 18.5）：从空白新建或保存 Codex 草稿
export function insertWorkflow(db: Db, definition: WorkflowDefinition, description: string) {
  assertNewWorkflow(db, definition);
  db.insert(workflowTable)
    .values({
      id: definition.id,
      name: definition.name,
      evalKind: null,
      definition,
      description,
      updatedAt: new Date(),
    })
    .run();
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
        .where(isNull(workflowTable.deletedAt))
        .orderBy(asc(workflowTable.createdAt), asc(workflowTable.id))
        .all()
        .sort((a, b) => order(a.id) - order(b.id))
        .map((r) => view(db, r));
    },

    get(id: string): WorkflowView {
      return view(db, workflowRow(db, id));
    },

    // 从空白新建（Contracts 18.5）：没有评测类型；同时建出第一个 variant"初稿"（入口与各小阶段的 SKILL.md 骨架）
    create(input: NewWorkflowBody): WorkflowView {
      const definition = checkedDefinition(input.definition, input.id, input.name);
      const existing = db.select().from(workflowTable).where(eq(workflowTable.id, input.id)).get();
      if (existing !== undefined) {
        throw new HttpError(
          409,
          existing.deletedAt === null
            ? `workflow ${input.id} 已存在`
            : `workflow ${input.id} 已存在：已删除的 workflow ${existing.name} 保留这个 id，换一个 id`,
        );
      }
      // 先写 workflow 行，再建 variant：variant 的 workflow 必须已存在
      insertWorkflow(db, definition, input.description.trim());
      variantsModule.createBlank({ workflowId: input.id, name: '初稿' });
      return view(db, workflowRow(db, input.id));
    },

    // 名字、描述与定义可改，评测类型不能改；内置的两个只能改描述，改了名字或定义时 409
    update(id: string, input: UpdateWorkflowBody): WorkflowView {
      const current = workflowRow(db, id);
      const definition = checkedDefinition(input.definition, id, input.name);
      if (
        isBuiltinWorkflow(id) &&
        JSON.stringify(definition) !== JSON.stringify(current.definition)
      ) {
        throw new HttpError(
          409,
          `${id} 是内置的 workflow，只能修改描述；要换入口或小阶段就从空白新建一个 workflow`,
        );
      }
      db.update(workflowTable)
        .set({
          name: definition.name,
          description: input.description.trim(),
          definition,
          updatedAt: new Date(),
        })
        .where(eq(workflowTable.id, id))
        .run();
      return view(db, workflowRow(db, id));
    },
  };
}

export type Workflows = ReturnType<typeof createWorkflows>;
