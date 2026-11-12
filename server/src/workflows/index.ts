import { createHash, randomUUID } from 'node:crypto';
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
import { releaseView } from '../variants/release.js';
import { evalSpec } from './eval-kinds.js';
import {
  ANALYSIS_WORKFLOW,
  BUILTIN_WORKFLOWS,
  type BuiltinWorkflow,
  type EvalSpec,
  isBuiltinWorkflow,
  isWfWorkflow,
  type NewWorkflowBody,
  type OwnBuiltinWorkflow,
  type UpdateWorkflowBody,
  WorkflowDefinition,
  type WorkflowView,
} from './schema.js';

// pnpm start running dist also reads from the source directory
const builtinFile = (id: BuiltinWorkflow) =>
  path.join(config.repoRoot, `server/src/workflows/${id}.yaml`);

// Skills of the session-analysis baseline variant (Contracts 19.2): shaped like src/, with skills/ under it
export const analysisBaselineSrc = path.join(
  config.repoRoot,
  'server/src/workflows/session-analysis',
);

const workflowsDir = path.join(config.repoRoot, 'server/src/workflows');

// src/ of the baseline variant of a built-in workflow the dashboard manages (Contracts 19.2, 33.1), passed to use.
// session-analysis is the repo directory itself; design and optimize are assembled from three parts of the repo: the
// entry skill in <id>/skills/, the authoring/ references (workflow rules, MCP, example) in the entry skill's directory,
// and the three third-party skills in external-skills/. Each call assembles its own directory under
// <dataDir>/builtin-baselines/ and deletes it afterwards, so processes sharing a data directory (tests) do not interfere
export function withBaselineSrc<T>(
  dataDir: string,
  id: OwnBuiltinWorkflow,
  use: (src: string) => T,
): T {
  if (id === ANALYSIS_WORKFLOW) return use(analysisBaselineSrc);
  const dir = path.join(dataDir, 'builtin-baselines', `${id}-${randomUUID()}`);
  const skills = path.join(dir, 'src', 'skills');
  fs.cpSync(path.join(workflowsDir, id, 'skills'), skills, { recursive: true });
  fs.cpSync(path.join(workflowsDir, 'authoring'), path.join(skills, id), { recursive: true });
  fs.cpSync(path.join(workflowsDir, 'external-skills'), skills, { recursive: true });
  try {
    return use(path.join(dir, 'src'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

type WorkflowRow = typeof workflowTable.$inferSelect;

// A definition that does not match the schema fails with zod's original message
export function parseDefinition(value: unknown, where: string): WorkflowDefinition {
  const result = WorkflowDefinition.safeParse(value);
  if (!result.success)
    throw new HttpError(
      400,
      `${where} does not match the workflow schema: ${result.error.message}`,
    );
  return result.data;
}

const BuiltinFile = z.looseObject({ description: z.string().trim().min(1) });

// The description in a built-in yaml is not part of the definition (Contracts 18.3); the rest is the definition
function readBuiltin(id: BuiltinWorkflow): { definition: WorkflowDefinition; description: string } {
  const file = builtinFile(id);
  const { description, ...rest } = BuiltinFile.parse(parse(fs.readFileSync(file, 'utf8')));
  const definition = parseDefinition(rest, file);
  if (definition.id !== id) throw new Error(`The id in ${file} should be ${id}: ${definition.id}`);
  return { definition, description };
}

export function builtinDefinition(id: BuiltinWorkflow): WorkflowDefinition {
  return readBuiltin(id).definition;
}

// The incremental stage partition state uses this to tell whether a definition changed
export function definitionHash(definition: WorkflowDefinition): string {
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex');
}

// At startup (after opening the database) writes lfg, ic and session-analysis from the built-in YAML: lfg and ic have
// the eval kind of the same name, session-analysis has none (Contracts 19.2). The yaml description is used only when
// there is none yet (edited on the page afterwards, Contracts 18.3)
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

// Includes deleted workflows: used only to show names (Contracts 24.5)
export function workflowRecord(db: Db, id: string): WorkflowRow {
  const found = db.select().from(workflowTable).where(eq(workflowTable.id, id)).get();
  if (found === undefined) throw new HttpError(404, `No workflow ${id}`);
  return found;
}

// Deleted workflows can no longer be used
export function workflowRow(db: Db, id: string): WorkflowRow {
  const found = workflowRecord(db, id);
  if (found.deletedAt !== null) throw new HttpError(404, `Workflow ${id} is deleted`);
  return found;
}

export function loadWorkflow(db: Db, id: string): WorkflowDefinition {
  return parseDefinition(workflowRow(db, id).definition, `workflow ${id}`);
}

// The run-time configuration of a workflow with an eval kind (16.2); 400 with the message when it has none
export function evalSpecOf(db: Db, workflowId: string): EvalSpec {
  const r = workflowRow(db, workflowId);
  if (r.evalKind === null) {
    throw new HttpError(
      400,
      `Workflow ${workflowId} has no eval kind and cannot be evaluated (it is used only for Live, the stage partition and analysis)`,
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
  if (v === undefined) throw new Error(`Variant ${variantId} does not exist`);
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
    release: isWfWorkflow(r.id) ? releaseView(db, r.id) : null,
    createdAt: r.createdAt.getTime(),
    updatedAt: r.updatedAt.getTime(),
  };
}

// The id and name in the definition must match the request
function checkedDefinition(value: unknown, id: string, name: string): WorkflowDefinition {
  const definition = parseDefinition(value, `The definition of workflow ${id}`);
  if (definition.id !== id || definition.name !== name) {
    throw new HttpError(
      400,
      `The id and name in the definition (${definition.id}, ${definition.name}) do not match the request (${id}, ${name})`,
    );
  }
  return definition;
}

// A workflow id is an entry command and must not share a name with any workflow's stage (otherwise a Skill call could
// not tell which one it is)
function assertEntryFree(db: Db, definition: WorkflowDefinition) {
  for (const r of db.select().from(workflowTable).where(isNull(workflowTable.deletedAt)).all()) {
    if (r.id === definition.id) continue;
    const other = parseDefinition(r.definition, `workflow ${r.id}`);
    if (other.stages.some((s) => s.id === definition.id)) {
      throw new HttpError(
        400,
        `Workflow id ${definition.id} has the name of a stage of workflow ${r.id}`,
      );
    }
  }
}

// Saving a Codex draft as a new workflow (Contracts 17.4): the id is unused and is not a stage name of another workflow
export function assertNewWorkflow(db: Db, definition: WorkflowDefinition) {
  const existing = db.select().from(workflowTable).where(eq(workflowTable.id, definition.id)).get();
  if (existing !== undefined) {
    throw new HttpError(
      400,
      existing.deletedAt === null
        ? `Workflow id ${definition.id} is already used`
        : `Workflow id ${definition.id} is already used: the deleted workflow ${existing.name} keeps this id, choose another id`,
    );
  }
  assertEntryFree(db, definition);
}

// A new workflow without an eval kind (Contracts 18.5): created from blank or from a saved Codex draft
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

// The service behind the Contracts 16.1 API
export function createWorkflows({ db, variants: variantsModule }: { db: Db; variants: Variants }) {
  return {
    // Built-in lfg and ic first, the rest in creation order
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

    // Create from blank (Contracts 18.5): no eval kind; also creates the first variant "First draft" (SKILL.md
    // skeletons for the entry and each stage)
    create(input: NewWorkflowBody): WorkflowView {
      const definition = checkedDefinition(input.definition, input.id, input.name);
      const existing = db.select().from(workflowTable).where(eq(workflowTable.id, input.id)).get();
      if (existing !== undefined) {
        throw new HttpError(
          409,
          existing.deletedAt === null
            ? `Workflow ${input.id} already exists`
            : `Workflow ${input.id} already exists: the deleted workflow ${existing.name} keeps this id, choose another id`,
        );
      }
      // Write the workflow row first, then create the variant: the variant's workflow must exist
      insertWorkflow(db, definition, input.description.trim());
      variantsModule.createBlank({ workflowId: input.id, name: 'First draft' });
      return view(db, workflowRow(db, input.id));
    },

    // Name, description and definition can change, the eval kind cannot; the built-in ones can change only the
    // description, and 409 when the name or definition changes
    update(id: string, input: UpdateWorkflowBody): WorkflowView {
      const current = workflowRow(db, id);
      const definition = checkedDefinition(input.definition, id, input.name);
      if (
        isBuiltinWorkflow(id) &&
        JSON.stringify(definition) !== JSON.stringify(current.definition)
      ) {
        throw new HttpError(
          409,
          `${id} is a built-in workflow and only its description can change; to change the entry or stages, create a new workflow from blank`,
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
