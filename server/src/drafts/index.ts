import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { asc, eq, isNull } from 'drizzle-orm';
import { stringify } from 'yaml';
import type { Db } from '../db/index.js';
import {
  analyses,
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
import { displayName, engineNames } from '../variants/names.js';
import type { Variant, Variants } from '../variants/index.js';
import { writeSkeleton } from '../variants/skills.js';
import {
  assertNewWorkflow,
  insertWorkflow,
  loadWorkflow,
  parseDefinition,
  workflowOfVariant,
} from '../workflows/index.js';
import { currentBaseline } from '../workflows/baselines.js';
import {
  DESIGN_WORKFLOW,
  type DraftWorkflow,
  OPTIMIZE_WORKFLOW,
  type WorkflowDefinition,
} from '../workflows/schema.js';
import {
  copyDraftSource,
  draftLayout,
  initialMessage,
  optimizeMessage,
  sessionSkillsDir,
  writeDraftDocs,
} from './dir.js';
import { recordSaved } from './snapshots.js';
import { checkDraftSkills, readDraftDefinition } from './validate.js';
import type {
  CreateDraftBody,
  DraftDiffView,
  DraftView,
  OptimizeBody,
  SaveDraftBody,
  SavePlanView,
  SessionVariantsView,
} from './views.js';

// Migration (Contracts 33.3): design and optimize drafts before 0027 are recorded as using the matching baseline, and their
// preparation steps become putting in its skills; called at server start after the baselines exist, so session auto-binding binds the baseline
export function backfillDraftVariants(db: Db, baselines: Record<DraftWorkflow, Variant>) {
  const legacy = db
    .select()
    .from(workflowDrafts)
    .where(isNull(workflowDrafts.designVariantId))
    .all();
  for (const d of legacy) {
    const baseline = baselines[draftWorkflowOf(d.mode)];
    db.update(workflowDrafts)
      .set({ designVariantId: baseline.id, steps: migrateDraftSteps(d.steps, baseline.name) })
      .where(eq(workflowDrafts.id, d.id))
      .run();
  }
}

export interface DraftsDeps {
  db: Db;
  variants: Variants;
  live: Live;
  // data/workflow-drafts
  draftsDir: string;
  // Data dir: an optimize draft's dir is analyses/<id>/ in it
  dataDir: string;
}

type DraftRow = typeof workflowDrafts.$inferSelect;

// The step that starts the session; its id stays start-codex from W42, the same for both engines, so steps recorded in existing drafts retry as usual
const START_STEP = 'start-codex';
// Put the skills of the workflow-design or workflow-optimize variant used into the session's skill dir (Contracts 33.2)
const SKILLS_STEP = 'copy-skills';

const copyLabel: Record<DraftMode, string> = {
  workflow: 'Write SKILL.md skeletons for the entry and each sub-stage',
  variant: 'Copy the base variant src',
  optimize: 'Copy the analysed variant src to optimize/src',
};

// Which built-in workflow's variant drives the session: workflow-design for designing a workflow or variant, workflow-optimize for optimising
export const draftWorkflowOf = (mode: DraftMode): DraftWorkflow =>
  mode === 'optimize' ? OPTIMIZE_WORKFLOW : DESIGN_WORKFLOW;

const pendingStep = (id: string, label: string): DraftStep => ({
  id,
  label,
  status: 'pending',
  error: null,
  startedAt: null,
  endedAt: null,
});

const skillsStep = (variantName: string) =>
  pendingStep(SKILLS_STEP, `Put in the skills of ${variantName}`);

// Draft preparation steps (Contracts 17.1, 19.3, 33.2): copy src (a skeleton for a new workflow), write workflow.yaml and PLATFORM.md,
// put in the skills of the variant used, start the session
function initialSteps(mode: DraftMode, engine: LiveEngine, variantName: string): DraftStep[] {
  return [
    pendingStep('copy-src', copyLabel[mode]),
    pendingStep('write-docs', 'Write workflow.yaml and PLATFORM.md'),
    skillsStep(variantName),
    pendingStep(START_STEP, `Start ${engineNames[engine]}`),
  ];
}

// Migrate the preparation steps of drafts before 0027 (one npx skills add each, copying optimize-from-report) into the single step that puts in the variant's skills;
// it is recorded as done when the session has already started
export function migrateDraftSteps(steps: DraftStep[], variantName: string): DraftStep[] {
  const legacy = (s: DraftStep) => s.id.startsWith('skill:') || s.id === 'copy-optimize-skill';
  if (!steps.some(legacy) || steps.some((s) => s.id === SKILLS_STEP)) return steps;
  const started = steps.find((s) => s.id === START_STEP)?.status === 'done';
  const next = started
    ? { ...skillsStep(variantName), status: 'done' as const }
    : skillsStep(variantName);
  const kept = steps.filter((s) => !legacy(s));
  const at = kept.findIndex((s) => s.id === START_STEP);
  return [...kept.slice(0, at), next, ...kept.slice(at)];
}

// A new workflow draft started from blank has one sub-stage, which Codex changes in workflow.yaml (Contracts 18.5)
const BLANK_STAGES = [{ id: 'stage-1' }];

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Prefilled name of a new workflow's first variant (Contracts 17.4)
const FIRST_VARIANT = 'First draft';

// Same definition means same entry and sub-stages (Contracts 19.1); the name is a workflow property, changed in the Workflow page
const sameStages = (a: WorkflowDefinition, b: WorkflowDefinition) =>
  isDeepStrictEqual({ id: a.id, stages: a.stages }, { id: b.id, stages: b.stages });

// The workflow name and description are required on save
function checkText(label: string, value: string, max: number): string {
  const text = value.trim();
  if (text === '') throw new HttpError(400, `${label} cannot be empty`);
  if (text.length > max) {
    throw new HttpError(
      400,
      `${label} is at most ${String(max)} characters, got ${String(text.length)}`,
    );
  }
  return text;
}

// Generate a workflow or variant with Codex (Contracts section 17)
export function createDrafts({ db, variants, live, draftsDir, dataDir }: DraftsDeps) {
  // Drafts still preparing when the server last exited will never finish: that step is failed and can be retried
  const interrupted = db
    .select()
    .from(workflowDrafts)
    .where(eq(workflowDrafts.status, 'preparing'))
    .all();
  for (const d of interrupted) {
    const error = 'Preparation interrupted by a service restart';
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
    if (found === undefined) throw new HttpError(404, `Draft not found: ${id}`);
    return found;
  }

  const dirOf = (r: Pick<DraftRow, 'id' | 'analysisId'>) =>
    r.analysisId === null ? path.join(draftsDir, r.id) : analysisLayout(dataDir, r.analysisId).dir;
  const layoutOf = (r: Pick<DraftRow, 'id' | 'mode' | 'analysisId'>) =>
    draftLayout(dirOf(r), r.mode);

  // Display of the variant the session uses (a deleted one is "<name> (deleted)", Contracts 24.3)
  function designVariantOf(r: DraftRow) {
    if (r.designVariantId === null) return null;
    const v = variants.record(r.designVariantId);
    return { id: v.id, name: displayName(v), deleted: v.deletedAt !== null };
  }

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
      // Deleted ones show "<name> (deleted)" and cannot be opened in the variant page (Contracts 24.3)
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
      designVariant: designVariantOf(r),
      dir: layoutOf(r).dir,
      createdAt: r.createdAt.getTime(),
    };
  }

  // Publish after writing state and progress: the draft and its Live item are both re-read
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

  // The draft's definition: for mode workflow, a blank definition with the id, name and one sub-stage; for variant and optimize, its workflow's definition
  function definitionOf(d: Pick<DraftRow, 'mode' | 'workflowId' | 'name'>) {
    if (d.mode !== 'workflow') return loadWorkflow(db, d.workflowId);
    return parseDefinition(
      { id: d.workflowId, name: d.name, stages: BLANK_STAGES },
      `definition of new workflow ${d.workflowId}`,
    );
  }

  function analysisRow(analysisId: string) {
    const a = db.select().from(analyses).where(eq(analyses.id, analysisId)).get();
    if (a === undefined) throw new HttpError(404, `Analysis not found: ${analysisId}`);
    return a;
  }

  // Put the skills of the workflow-design or workflow-optimize variant used into the session's skill dir (Contracts 33.2):
  // .claude/skills/ for Claude Code, .agents/skills/ for Codex; same-named entries are deleted first
  function copySessionSkills(d: DraftRow, skillsDir: string) {
    if (d.designVariantId === null) throw new Error(`Draft ${d.id} has no recorded variant`);
    const from = variants.layout(d.designVariantId).skills;
    fs.mkdirSync(skillsDir, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const to = path.join(skillsDir, entry.name);
      fs.rmSync(to, { recursive: true, force: true });
      fs.cpSync(path.join(from, entry.name), to, { recursive: true, verbatimSymlinks: true });
    }
  }

  async function runStep(id: string, stepId: string) {
    const d = row(id);
    const layout = layoutOf(d);
    if (stepId === 'copy-src') {
      if (d.mode === 'optimize') {
        // The analysis dir may hold session-analysis skills used by the Codex engine; the optimize session installs only its own
        fs.rmSync(path.dirname(layout.agentSkills), { recursive: true, force: true });
        fs.rmSync(layout.claudeSkills, { recursive: true, force: true });
      }
      await copyDraftSource(layout, async (dest) => {
        if (d.baseVariantId === null) writeSkeleton(path.join(dest, 'skills'), definitionOf(d));
        else await variants.exportSource(d.baseVariantId, dest);
      });
    } else if (stepId === 'write-docs') {
      const base = d.baseVariantId === null ? null : variants.record(d.baseVariantId);
      writeDraftDocs(layout, {
        mode: d.mode,
        engine: d.engine,
        definition: definitionOf(d),
        base: base === null ? null : { id: base.id, name: displayName(base) },
        analysisId: d.analysisId,
      });
    } else if (stepId === SKILLS_STEP) {
      copySessionSkills(d, sessionSkillsDir(layout, d.engine));
    } else if (stepId === START_STEP) {
      if (d.liveId === null) throw new Error(`The Live item of draft ${id} was deleted`);
      await live.startDraft(d.liveId);
    } else {
      throw new Error(`Unknown preparation step: ${stepId}`);
    }
  }

  // Continue from the first step not done (on retry, the failed one); when preparation is done the status is open, then Codex starts
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
        update(id, { status: 'failed', error: `${step.label} failed: ${failed}` });
        return;
      }
      setStep(id, step.id, { status: 'done', endedAt: Date.now() });
    }
  }

  // Create the draft and its Live item (no process yet); prepare readies the draft dir in the background
  // The workflow-design or workflow-optimize variant the session uses (Contracts 33.2): the baseline when none is chosen; it must belong to that workflow
  // and be built from its current content
  function sessionVariant(mode: DraftMode, variantId: string | undefined): Variant {
    const workflowId = draftWorkflowOf(mode);
    const v =
      variantId === undefined ? currentBaseline(db, dataDir, workflowId) : variants.get(variantId);
    if (v === null)
      throw new HttpError(
        409,
        `No baseline variant of ${workflowId} yet (created when the server starts)`,
      );
    if (v.workflowId !== workflowId) {
      throw new HttpError(
        400,
        `Variant ${v.name} belongs to workflow ${v.workflowId}; ${mode === 'optimize' ? 'optimize' : 'design'} sessions can only use ${workflowId} variants`,
      );
    }
    if (v.buildStatus !== 'built' || v.builtHash !== v.skillsHash) {
      throw new HttpError(
        409,
        `Variant ${v.name} is not built from its current content; build it before using it`,
      );
    }
    return v;
  }

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
          `Base variant ${base.name} belongs to workflow ${base.workflowId}, not ${body.workflowId}`,
        );
      }
    }
    const design = sessionVariant(body.mode, body.designVariantId);
    const id = newId('d');
    const item = live.createDraftItem({
      cwd: path.join(draftsDir, id),
      prompt: initialMessage(body.requirement, body.engine),
      // Named by workflow id or variant name; the page shows the engine as a logo (Contracts 28.4)
      title: base === null ? body.workflowId : `${body.workflowId} · ${base.name}`,
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
        designVariantId: design.id,
        requirement: body.requirement,
        liveId: item.id,
        status: 'preparing',
        steps: initialSteps(body.mode, body.engine, design.name),
      })
      .run();
    events.publish({ type: 'draft.updated', draftId: id, status: 'preparing' });
    events.publish({ type: 'live.updated', liveId: item.id });
    return { draft: view(row(id)), live: live.get(item.id) };
  }

  // Hand to an agent for optimisation (Contracts 19.3, 22.1, 33.2): the draft dir is the analysis dir, the base is the analysed variant, the workflow is its
  // workflow; the session is driven by the chosen workflow-optimize variant
  function openOptimize(
    analysisId: string,
    body: OptimizeBody,
  ): { draft: DraftView; live: LiveDetail } {
    const { engine } = body;
    const a = analysisRow(analysisId);
    if (a.status !== 'succeeded' || a.report === null) {
      throw new HttpError(
        409,
        `Analysis ${analysisId} has not succeeded and has no report to optimise from`,
      );
    }
    if (a.variantId === null) {
      throw new HttpError(
        409,
        `Analysis ${analysisId} analysed local-machine sessions and has no variant to optimise`,
      );
    }
    const base = variants.get(a.variantId);
    const workflowId = workflowOfVariant(db, base.id);
    const design = sessionVariant('optimize', body.designVariantId);
    const prompt = optimizeMessage({ analysisId, workflowId, variantName: base.name, engine });
    const id = newId('d');
    const item = live.createDraftItem({
      cwd: analysisLayout(dataDir, analysisId).dir,
      prompt,
      title: `${workflowId} · ${base.name}`,
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
        designVariantId: design.id,
        analysisId,
        requirement: prompt,
        liveId: item.id,
        status: 'preparing',
        steps: initialSteps('optimize', engine, design.name),
      })
      .run();
    events.publish({ type: 'draft.updated', draftId: id, status: 'preparing' });
    events.publish({ type: 'live.updated', liveId: item.id });
    return { draft: view(row(id)), live: live.get(item.id) };
  }

  // Which workflow to save to (Contracts 17.4, 19.3): the definition, whether a new workflow is created, and the parent of a new variant
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
      // optimize/workflow.yaml has the same entry and sub-stages as the original workflow: save to it, with the analysed variant as parent
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
    // Saving again: save to the new workflow already saved; the entry and sub-stages must be unchanged
    const saved = loadWorkflow(db, draft.savedWorkflowId);
    if (!sameStages(saved, definition)) {
      throw new HttpError(
        400,
        `workflow.yaml differs from the definition of saved workflow ${saved.id}; change the definition in the Workflow page or open another draft.\nSaved:\n${stringify(saved)}\nworkflow.yaml:\n${stringify(definition)}`,
      );
    }
    // Variants under a new workflow have no parent: the analysed variant belongs to another workflow
    return {
      definition: saved,
      newWorkflow: false,
      parentId: draft.mode === 'optimize' ? null : draft.baseVariantId,
    };
  }

  // Contents of the save dialog (Contracts 17.4): the first save as a new workflow fills in the workflow and first variant;
  // otherwise list the same workflow's variants, where imported and frozen ones cannot be overwritten, with the reason
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
    // A deleted base still shows its name (" (deleted)", Contracts 24.3)
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

  // Prefilled description of a new workflow: for mode workflow, the one entered when starting; for optimize, its origin
  const newWorkflowDescription = (draft: DraftRow) =>
    draft.mode === 'optimize'
      ? `Changed from workflow ${draft.workflowId} by ${engineNames[draft.engine]} following the report of analysis ${draft.analysisId ?? ''}`
      : (draft.description ?? '');

  // Validate, then create the workflow and variant or overwrite an existing variant; not built, the variant is unbuilt (Contracts 17.4).
  // Any failed check fails with its original text; the draft stays and nothing changes
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
          `First save as new workflow ${definition.id}: fill in the workflow name and description`,
        );
      }
      if (target.kind !== 'new') {
        throw new HttpError(
          400,
          `New workflow ${definition.id} has no variants yet; only a first variant can be created`,
        );
      }
      saved = { ...definition, name: checkText('Workflow name', body.workflow.name, 100) };
      const workflowDescription = checkText(
        'Workflow description',
        body.workflow.description,
        2000,
      );
      insertWorkflow(db, saved, workflowDescription);
    } else if (body.workflow !== undefined) {
      throw new HttpError(
        400,
        `Saving to existing workflow ${definition.id}: leave out the workflow name and description (change them in the Workflow page)`,
      );
    }
    const source = draft.analysisId === null ? '' : `, analysis ${draft.analysisId}`;
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
        note: `Saved from ${engineNames[draft.engine]} draft ${id} (${parent === null ? 'no base' : `base ${displayName(parent)}, ${parent.id}`}${source}); needs a build`,
      });
    } else {
      const existing = variants.get(target.variantId);
      if (existing.workflowId !== saved.id) {
        throw new HttpError(
          400,
          `Variant ${existing.name} belongs to workflow ${existing.workflowId}; this draft saves to ${saved.id} and can only overwrite its variants`,
        );
      }
      variant = variants.overwriteFromSource(existing.id, {
        srcDir: layout.src,
        name,
        description,
        draftId: id,
        draftEngine: draft.engine,
        analysisId: draft.analysisId,
      });
    }
    update(id, { status: 'saved', savedWorkflowId: saved.id, savedVariantId: variant.id });
    // "Last saved" in the panel's Compare (Contracts 26.4)
    recordSaved(layout);
    return view(row(id));
  }

  const savable: DraftStatus[] = ['open', 'saved'];

  function savableRow(id: string): DraftRow {
    const d = row(id);
    if (!savable.includes(d.status)) {
      throw new HttpError(
        409,
        `Draft ${id} is ${d.status}; it can be saved once preparation is done`,
      );
    }
    return d;
  }

  return {
    get: (id: string) => view(row(id)),

    sessionVariants(): SessionVariantsView {
      const choice = (workflowId: DraftWorkflow) => ({
        defaultId: currentBaseline(db, dataDir, workflowId)?.id ?? null,
        variants: variants
          .list()
          .filter(
            (v) =>
              v.workflowId === workflowId &&
              v.buildStatus === 'built' &&
              v.builtHash === v.skillsHash,
          )
          .reverse()
          .map((v) => ({ id: v.id, name: v.name })),
      });
      return { design: choice(DESIGN_WORKFLOW), optimize: choice(OPTIMIZE_WORKFLOW) };
    },

    // Workflow panel of design and optimize sessions (Contracts 26.4): this item's draft, working dir and the base's src/. When the base is deleted
    // its files are gone (24.3), the same as having no base
    workspaceOf(liveId: string) {
      const d = db.select().from(workflowDrafts).where(eq(workflowDrafts.liveId, liveId)).get();
      if (d === undefined)
        throw new HttpError(
          404,
          `Live item ${liveId} is not a design or optimize session and has no draft`,
        );
      const base = d.baseVariantId === null ? null : variants.record(d.baseVariantId);
      return {
        draft: d,
        layout: layoutOf(d),
        base: base === null ? null : { id: base.id, name: displayName(base) },
        baseSrc: base?.deletedAt === null ? variants.layout(base.id).src : null,
      };
    },

    // Preview of changes before saving (Contracts 17.4, 21.3): diff of the src/ to be saved against the target. against is the overwritten variant;
    // without it, against the base (when creating); a blank-start draft has no base; a deleted base's files are gone, so everything is new (Contracts 24.3)
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

    // Prepare the draft dir in the background; the promise resolves when preparation ends (done or a step failed), so tests can await it
    prepare,

    // Start (Contracts 17.1): create the draft and Live item and return at once; the draft dir is prepared in the background
    create(body: CreateDraftBody): { draft: DraftView; live: LiveDetail } {
      const created = open(body);
      void prepare(created.draft.id);
      return created;
    },

    openOptimize,

    // Hand to an agent for optimisation (Contracts 19.3): like starting, returns at once; preparation in the analysis dir runs in the background
    optimize(analysisId: string, body: OptimizeBody): { draft: DraftView; live: LiveDetail } {
      const created = openOptimize(analysisId, body);
      void prepare(created.draft.id);
      return created;
    },

    // Retry preparation from the failed step
    retry(id: string): DraftView {
      const d = row(id);
      if (d.status !== 'failed') {
        throw new HttpError(
          409,
          `Draft ${id} is ${d.status}; only drafts whose preparation failed can be retried`,
        );
      }
      update(id, { status: 'preparing', error: null });
      void prepare(id);
      return view(row(id));
    },

    // Save (Contracts 17.4): create a variant or overwrite an existing one, without building
    save(id: string, body: SaveDraftBody): DraftView {
      savableRow(id);
      return saveDraft(id, body);
    },
  };
}

export type Drafts = ReturnType<typeof createDrafts>;
