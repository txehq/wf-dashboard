import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@decimalturn/toml-patch';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import {
  type AnalysisEngine,
  analyses,
  analysisFindings,
  analysisPatches,
  type AnalysisStep,
  runs,
  type SessionEngine,
  sessions,
  type VariantBinding,
  variants as variantsTable,
  workflowDrafts,
} from '../db/schema.js';
import { sessionTitles } from '../api/session-titles.js';
import { events } from '../events.js';
import { models } from '../llm/client.js';
import { writeCodexHome } from '../variants/codex-home.js';
import type { RequireChecks } from '../environment.js';
import { HttpError } from '../variants/errors.js';
import type { Variants } from '../variants/index.js';
import { displayName } from '../variants/names.js';
import { loadWorkflow, workflowOfVariant } from '../workflows/index.js';
import { ANALYSIS_WORKFLOW, SYNTHESIZE_STAGE } from '../workflows/schema.js';
import { currentBaseline } from '../workflows/baselines.js';
import { type EngineCommand, engineCommand, runEngine } from './engines.js';
import { writeInput } from './export.js';
import { configSourceDirs, isLocalSession } from '../ingest/session-config.js';
import {
  type AnalysisEntry,
  analysisEntries,
  projectName,
  sessionConfig,
} from '../ingest/session-import.js';
import { readForAnalysis, type SourceDirs } from '../ingest/sources.js';
import { analysisSandboxProfile } from './sandbox.js';
import {
  evidenceIndex,
  type FileProposal,
  findingsFile,
  validateFindings,
  validatePatches,
  validateReport,
  type ValidatedFinding,
  writeFindingsWithIds,
} from './validate.js';

// Contracts 15.2, 15.3, 19.2: analyse sessions and save proposed changes as a variant. The aspects are the
// sub-stages of the chosen session-analysis variant; each stage's engine process is driven by its skill

export type Analysis = typeof analyses.$inferSelect;
type Variant = typeof variantsTable.$inferSelect;

export interface InsightsOptions {
  db: Db;
  variants: Variants;
  dataDir: string;
  // Config dirs (the analysis scope follows each session's config, Contracts 27); defaults to the server's source dirs
  dirs?: SourceDirs | undefined;
  codexAuthPath?: string | undefined;
  codexConfigPath?: string | undefined;
  // Paid environment checks (Contracts 8): Codex before a Codex analysis starts
  requireChecks: RequireChecks;
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

// Abort reason on cancel; distinct from engine and validation failures
const CANCELLED = new Error('Analysis cancelled');

// a-<yyyymmdd>-<6 lowercase letters or digits>
export function newAnalysisId(now = new Date()): string {
  const day = now.toISOString().slice(0, 10).replaceAll('-', '');
  const suffix = Array.from({ length: 6 }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join(
    '',
  );
  return `a-${day}-${suffix}`;
}

const CodexConfig = z.looseObject({ model: z.string().min(1) });

// Codex's default model: model in ~/.codex/config.toml
export function codexDefaultModel(configPath: string = config.codexConfigPath): string {
  return CodexConfig.parse(parse(fs.readFileSync(configPath, 'utf8'))).model;
}

// Engine process prompt: invoke the entry skill with the stage name (Contracts 19.2). Claude Code uses a slash command, Codex a $skill mention
export function stagePrompt(engine: AnalysisEngine, stage: string): string {
  return engine === 'claude' ? `/${ANALYSIS_WORKFLOW} ${stage}` : `$${ANALYSIS_WORKFLOW} ${stage}`;
}

const pendingStep = (key: string): AnalysisStep => ({
  key,
  status: 'pending',
  startedAt: null,
  endedAt: null,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  costUsd: null,
  events: 0,
  error: null,
});

export interface ScopeSession {
  id: string;
  title: string | null;
  startedAt: string;
  runId: string | null;
  variant: { id: string; name: string } | null;
  binding: VariantBinding | null;
  // Session of the local machine's config (Contracts 25.4)
  local: boolean;
  engine: SessionEngine;
  // Its config (Contracts 27): local or variant:<id>, with a label; null when in no config
  config: { id: string; label: string } | null;
  // Project: the directory name of the working directory
  project: string | null;
  // Already in the dashboard; when false it is read in when the analysis starts (not added to the management table)
  inDashboard: boolean;
}

export interface Scope {
  sessions: ScopeSession[];
  // All sessions of one analysis share one engine and one config (Contracts 25.4, 27); null otherwise
  engine: SessionEngine | null;
  config: { id: string; label: string } | null;
  variant: { id: string; name: string } | null;
  // All chosen sessions belong to the local machine's config: the analysis has no variant (Contracts 25.4)
  local: boolean;
  // Why the scope cannot be analysed; null when it can
  problem: string | null;
}

// Analysis scope: sessions already in the dashboard (ids), a batch, and files picked from disk in a new analysis (Contracts 27)
export interface ScopeInput {
  sessionIds?: string[] | undefined;
  batchId?: string | undefined;
  disk?: { engine: SessionEngine; files: string[] } | undefined;
}

export interface NewAnalysisInput extends ScopeInput {
  engine: AnalysisEngine;
  model?: string | undefined;
  // The session-analysis variant to analyse with (Contracts 19.2); defaults to the baseline
  analysisVariantId?: string | undefined;
}

export interface AnalysisDetail extends Analysis {
  // Null for analyses of local-machine sessions (Contracts 25.4)
  variantName: string | null;
  analysisVariantName: string | null;
  variantDeleted: boolean;
  analysisVariantDeleted: boolean;
  sessions: ScopeSession[];
  findings: (typeof analysisFindings.$inferSelect)[];
  patches: (typeof analysisPatches.$inferSelect)[];
  files: FileProposal[];
  // Drafts handed to Codex for optimisation (Contracts 19.3), in the order started
  optimizeDrafts: { id: string; liveId: string | null }[];
}

// One stage's engine process: prompt, config dir, sandbox and the full command (Contracts 19.2)
export interface StagePlan {
  key: string;
  prompt: string;
  engineHome: string;
  // The engine loads this variant's skills from here
  skillsDir: string;
  profile: string;
  command: EngineCommand;
}

export const analysisLayout = (dataDir: string, id: string) => {
  const dir = path.join(dataDir, 'analyses', id);
  return {
    dir,
    input: path.join(dir, 'input'),
    output: path.join(dir, 'output'),
    logs: path.join(dir, 'logs'),
    check: path.join(dir, 'check'),
    proposals: path.join(dir, 'proposals.json'),
    // The Codex engine loads skills from .agents/skills in its cwd (Contracts 17.3, 19.2)
    agentSkills: path.join(dir, '.agents', 'skills'),
  };
};

export function createInsights({
  db,
  variants,
  dataDir,
  dirs: sourceDirs = configSourceDirs,
  codexAuthPath = config.codexAuthPath,
  codexConfigPath = config.codexConfigPath,
  requireChecks,
}: InsightsOptions) {
  const controllers = new Map<string, AbortController>();
  // Shared CODEX_HOME for the Codex engine; the Claude Code engine uses the chosen variant's own config dir (Contracts 18.6)
  const homes = { codex: path.join(dataDir, 'analysis-home', 'codex') };

  // Analyses still in progress when the server last exited will never finish
  for (const row of db
    .select({ id: analyses.id, steps: analyses.steps })
    .from(analyses)
    .where(inArray(analyses.status, ['queued', 'running']))
    .all()) {
    db.update(analyses)
      .set({
        status: 'failed',
        error: 'Interrupted by a service restart',
        endedAt: new Date(),
        steps: row.steps.map((s) =>
          s.status === 'running' || s.status === 'pending' ? { ...s, status: 'cancelled' } : s,
        ),
      })
      .where(eq(analyses.id, row.id))
      .run();
  }

  function get(id: string): Analysis {
    const row = db.select().from(analyses).where(eq(analyses.id, id)).get();
    if (row === undefined) throw new HttpError(404, `Analysis not found: ${id}`);
    return row;
  }

  function publish(id: string) {
    events.publish({ type: 'analysis.updated', analysisId: id, status: get(id).status });
  }

  function update(id: string, values: Partial<typeof analyses.$inferInsert>) {
    db.update(analyses).set(values).where(eq(analyses.id, id)).run();
    publish(id);
  }

  // Step state is written back to steps; event counts are written at most once per step every 2 seconds
  const lastEventWrite = new Map<string, number>();
  function updateStep(id: string, key: string, change: Partial<AnalysisStep>) {
    const row = get(id);
    const steps = row.steps.map((s) => (s.key === key ? { ...s, ...change } : s));
    const cost = steps.some((s) => s.costUsd !== null)
      ? steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0)
      : null;
    update(id, { steps, costUsd: cost });
  }
  function countEvent(id: string, key: string) {
    const row = get(id);
    const step = row.steps.find((s) => s.key === key);
    if (step === undefined) throw new Error(`Analysis ${id} has no step ${key}`);
    const mark = `${id}:${key}`;
    const now = Date.now();
    const count = step.events + 1;
    if (now - (lastEventWrite.get(mark) ?? 0) < 2_000) {
      db.update(analyses)
        .set({ steps: row.steps.map((s) => (s.key === key ? { ...s, events: count } : s)) })
        .where(eq(analyses.id, id))
        .run();
      return;
    }
    lastEventWrite.set(mark, now);
    updateStep(id, key, { events: count });
  }

  // Display name: a deleted variant shows as "<name> (deleted)" (Contracts 24.3)
  function variantRecord(variantId: string) {
    const v = db
      .select({ name: variantsTable.name, deletedAt: variantsTable.deletedAt })
      .from(variantsTable)
      .where(eq(variantsTable.id, variantId))
      .get();
    if (v === undefined) throw new Error(`Variant not found: ${variantId}`);
    return v;
  }
  const variantName = (variantId: string) => displayName(variantRecord(variantId));
  const isDeleted = (variantId: string | null) =>
    variantId !== null && variantRecord(variantId).deletedAt !== null;

  function scopeSessions(sessionIds: string[]): ScopeSession[] {
    const rows = db
      .select({
        id: sessions.id,
        startedAt: sessions.startedAt,
        runId: sessions.runId,
        variantId: sessions.variantId,
        binding: sessions.variantBinding,
        engine: sessions.engine,
        filePath: sessions.filePath,
        cwd: sessions.cwd,
      })
      .from(sessions)
      .where(inArray(sessions.id, sessionIds))
      .all();
    // Same titles as the Sessions list
    const titles = sessionTitles(db, sessionIds);
    return sessionIds.map((id) => {
      const r = rows.find((s) => s.id === id);
      if (r === undefined) throw new HttpError(404, `Session not found: ${id}`);
      return {
        id: r.id,
        title: titles.get(r.id) ?? null,
        startedAt: r.startedAt.toISOString(),
        runId: r.runId,
        variant: r.variantId === null ? null : { id: r.variantId, name: variantName(r.variantId) },
        binding: r.binding,
        local: isLocalSession(sourceDirs, r.engine, r.filePath),
        engine: r.engine,
        config: sessionConfig(db, sourceDirs, r.engine, r.filePath, r.variantId),
        project: r.cwd === null ? null : projectName(r.cwd),
        inDashboard: true,
      };
    });
  }

  // Sessions of all runs in a batch
  function batchSessionIds(batchId: string): string[] {
    const rows = db
      .select({ id: runs.id, sessionId: runs.sessionId })
      .from(runs)
      .where(eq(runs.batchId, batchId))
      .orderBy(asc(runs.createdAt), asc(runs.id))
      .all();
    if (rows.length === 0) throw new HttpError(404, `Batch ${batchId} has no runs`);
    const imported = new Set(
      db
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          inArray(
            sessions.id,
            rows.map((r) => r.sessionId),
          ),
        )
        .all()
        .map((s) => s.id),
    );
    const missing = rows.filter((r) => !imported.has(r.sessionId));
    if (missing.length > 0) {
      throw new HttpError(
        409,
        `These runs have no session yet (queued or not started): ${missing.map((r) => r.id).join(', ')}`,
      );
    }
    return rows.map((r) => r.sessionId);
  }

  // Sessions in scope and the files to read in when the analysis starts: picked files already in the dashboard use
  // their record (config taken from the third column that lists it), the rest use the start of the file
  function resolve(input: ScopeInput): { scope: Scope; pending: AnalysisEntry[] } {
    const ids =
      input.batchId !== undefined ? batchSessionIds(input.batchId) : (input.sessionIds ?? []);
    const disk =
      input.disk === undefined
        ? []
        : analysisEntries(db, sourceDirs, input.disk.engine, input.disk.files);
    const all = [...ids, ...disk.map((e) => e.id)];
    if (all.length === 0) throw new HttpError(400, 'No session selected');
    if (new Set(all).size !== all.length) throw new HttpError(400, 'Duplicate sessions');
    const stored = new Set(
      disk.length === 0
        ? []
        : db
            .select({ id: sessions.id })
            .from(sessions)
            .where(
              inArray(
                sessions.id,
                disk.map((e) => e.id),
              ),
            )
            .all()
            .map((r) => r.id),
    );
    const pending = new Map(disk.filter((e) => !stored.has(e.id)).map((e) => [e.id, e]));
    const fromDisk = new Map(disk.map((e) => [e.id, e]));
    const recorded = new Map(
      scopeSessions(all.filter((id) => !pending.has(id))).map((s) => [s.id, s]),
    );
    const list = all.map((id): ScopeSession => {
      const record = recorded.get(id);
      const entry = fromDisk.get(id);
      if (record !== undefined)
        return entry === undefined ? record : { ...record, config: entry.config };
      const file = pending.get(id);
      if (file === undefined) throw new Error(`Session ${id} has neither a record nor a file`);
      return {
        id,
        title: file.title,
        startedAt: file.startedAt.toISOString(),
        runId: null,
        variant: null,
        binding: null,
        local: file.config.id === 'local',
        engine: file.engine,
        config: file.config,
        project: projectName(file.cwd),
        inDashboard: false,
      };
    });
    return { scope: checkedScope(list), pending: [...pending.values()] };
  }

  // All sessions of one analysis share one engine and one config (Contracts 25.4, 27): the local machine's or one variant's
  function checkedScope(list: ScopeSession[]): Scope {
    const short = (s: ScopeSession[]) => s.map((x) => x.id.slice(0, 8)).join(', ');
    const engines = [...new Set(list.map((s) => s.engine))];
    const configs = [...new Map(list.map((s) => [s.config?.id, s.config])).values()];
    const config = configs.length === 1 ? (configs[0] ?? null) : null;
    const problem = (text: string): Scope => ({
      sessions: list,
      engine: engines.length === 1 ? (engines[0] ?? null) : null,
      config,
      variant: null,
      local: false,
      problem: text,
    });
    if (engines.length > 1)
      return problem(
        'Selected sessions must use one engine; both Claude Code and Codex are selected',
      );
    const outside = list.filter((s) => s.config === null);
    if (outside.length > 0) return problem(`These sessions are in no config: ${short(outside)}`);
    if (config === null) {
      return problem(
        `Selected sessions must belong to one config; they belong to: ${configs.map((c) => c?.label).join(', ')}`,
      );
    }
    const engine = engines[0] ?? null;
    if (config.id === 'local')
      return { sessions: list, engine, config, variant: null, local: true, problem: null };
    const variantId = config.id.slice('variant:'.length);
    return {
      sessions: list,
      engine,
      config,
      variant: { id: variantId, name: variantName(variantId) },
      local: false,
      problem: null,
    };
  }

  const scope = (input: ScopeInput): Scope => resolve(input).scope;

  // session-analysis variants a new analysis may use: those built from their current content (Contracts 19.2)
  function analysisVariants(): Variant[] {
    return db
      .select()
      .from(variantsTable)
      .where(eq(variantsTable.workflowId, ANALYSIS_WORKFLOW))
      .orderBy(desc(variantsTable.createdAt))
      .all()
      .filter((v) => v.buildStatus === 'built' && v.builtHash === v.skillsHash);
  }

  // Analysis steps: the session-analysis sub-stages, the last being synthesize
  function stageKeys(): { aspects: string[]; synthesize: string } {
    const ids = loadWorkflow(db, ANALYSIS_WORKFLOW).stages.map((s) => s.id);
    const last = ids.at(-1);
    if (last !== SYNTHESIZE_STAGE) {
      throw new Error(
        `The last sub-stage of workflow ${ANALYSIS_WORKFLOW} should be ${SYNTHESIZE_STAGE}: ${String(last)}`,
      );
    }
    return { aspects: ids.slice(0, -1), synthesize: last };
  }

  function checkedAnalysisVariant(variantId: string): Variant {
    const v = variants.get(variantId);
    if (workflowOfVariant(db, v.id) !== ANALYSIS_WORKFLOW) {
      throw new HttpError(
        400,
        `Variant ${v.name} belongs to workflow ${v.workflowId}; analyses can only use ${ANALYSIS_WORKFLOW} variants`,
      );
    }
    if (v.buildStatus !== 'built' || v.builtHash !== v.skillsHash) {
      throw new HttpError(
        409,
        `Variant ${v.name} is not built from its current content; build it before using it for analysis`,
      );
    }
    return v;
  }

  // Each stage's engine process (not started): Claude Code's CLAUDE_CONFIG_DIR is the chosen variant's own config dir,
  // whose skills/ holds its skills; Codex's skills are copied to .agents/skills in the analysis dir. Auth and model config are refreshed each time per 7.10
  function planStages(
    row: Pick<Analysis, 'id' | 'engine' | 'model' | 'analysisVariantId' | 'steps'>,
  ): StagePlan[] {
    if (row.analysisVariantId === null)
      throw new Error(`Analysis ${row.id} has no session-analysis variant`);
    const dirs = analysisLayout(dataDir, row.id);
    const variantId = checkedAnalysisVariant(row.analysisVariantId).id;
    let engineHome: string;
    let skillsDir: string;
    if (row.engine === 'claude') {
      variants.refreshAuthEnv(variantId);
      engineHome = variants.runtimeEnv(variantId).env.CLAUDE_CONFIG_DIR;
      skillsDir = path.join(engineHome, 'skills');
    } else {
      writeCodexHome(homes.codex, { authPath: codexAuthPath, configPath: codexConfigPath });
      engineHome = homes.codex;
      skillsDir = dirs.agentSkills;
      fs.rmSync(skillsDir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(skillsDir), { recursive: true });
      fs.cpSync(variants.layout(variantId).skills, skillsDir, { recursive: true });
    }
    const profile = analysisSandboxProfile({
      analysisDir: dirs.dir,
      engineHome,
      repoRoot: config.repoRoot,
      dataDir,
    });
    return row.steps.map(({ key }) => {
      const prompt = stagePrompt(row.engine, key);
      return {
        key,
        prompt,
        engineHome,
        skillsDir,
        profile,
        command: engineCommand({ engine: row.engine, model: row.model, prompt, engineHome }),
      };
    });
  }

  async function runStep(row: Analysis, plan: StagePlan, signal: AbortSignal): Promise<void> {
    const dirs = analysisLayout(dataDir, row.id);
    updateStep(row.id, plan.key, { status: 'running', startedAt: Date.now() });
    const result = await runEngine({
      engine: row.engine,
      command: plan.command,
      cwd: dirs.dir,
      engineHome: plan.engineHome,
      profile: plan.profile,
      logFile: path.join(dirs.logs, `${plan.key}.log`),
      signal,
      onEvent: () => {
        countEvent(row.id, plan.key);
      },
    });
    updateStep(row.id, plan.key, { tokens: result.tokens, costUsd: result.costUsd });
  }

  // Validation after a step counts as part of it: on failure the step is failed with the original message in error
  async function step<T>(
    row: Analysis,
    plan: StagePlan,
    signal: AbortSignal,
    check: () => T | Promise<T>,
  ): Promise<T> {
    return runStep(row, plan, signal)
      .then(check)
      .then(
        (value) => {
          updateStep(row.id, plan.key, { status: 'succeeded', endedAt: Date.now() });
          return value;
        },
        (error: unknown) => {
          const cancelled = signal.aborted;
          updateStep(row.id, plan.key, {
            status: cancelled ? 'cancelled' : 'failed',
            endedAt: Date.now(),
            error: cancelled ? null : error instanceof Error ? error.message : String(error),
          });
          throw error;
        },
      );
  }

  function planOf(plans: StagePlan[], key: string): StagePlan {
    const plan = plans.find((p) => p.key === key);
    if (plan === undefined) throw new Error(`No engine process for stage ${key}`);
    return plan;
  }

  async function execute(id: string, controller: AbortController) {
    const { signal } = controller;
    const dirs = analysisLayout(dataDir, id);
    update(id, { status: 'running' });
    const row = get(id);
    for (const dir of [dirs.output, dirs.logs]) fs.mkdirSync(dir, { recursive: true });
    const variantId = row.variantId;
    const exported = await writeInput(db, {
      analysisId: id,
      // Analyses of local-machine sessions have no variant: no skills/ or workflow.yaml, no stages (Contracts 25.4)
      variant:
        variantId === null
          ? null
          : {
              id: variantId,
              name: variantName(variantId),
              skillsDir: variants.layout(variantId).skills,
              workflow: loadWorkflow(db, workflowOfVariant(db, variantId)),
            },
      sessionIds: row.sessionIds,
      inputDir: dirs.input,
    });
    signal.throwIfAborted();
    const index = evidenceIndex(exported);
    const plans = planStages(row);
    const { aspects, synthesize } = stageKeys();

    const found = await Promise.all(
      aspects.map((aspect) =>
        step(row, planOf(plans, aspect), signal, () => {
          const file = path.join(dirs.output, findingsFile(aspect));
          const findings = validateFindings(file, aspect, index);
          writeFindingsWithIds(file, findings);
          return findings;
        }).catch((error: unknown) => {
          // When one aspect fails, stop the other engine processes
          controller.abort(error);
          throw error;
        }),
      ),
    );
    const findings: ValidatedFinding[] = found.flat();
    db.transaction((tx) => {
      for (const f of findings) {
        tx.insert(analysisFindings)
          .values({
            analysisId: id,
            findingId: f.findingId,
            aspect: f.aspect,
            title: f.title,
            stage: f.stage,
            skill: f.skill,
            severity: f.severity,
            detail: f.detail,
            evidence: f.evidence,
          })
          .run();
      }
    });
    publish(id);

    const findingIds = new Set(findings.map((f) => f.findingId));
    // Local-machine analyses produce only a report, no proposed changes (Contracts 25.4)
    if (variantId === null) {
      const report = await step(row, planOf(plans, synthesize), signal, () =>
        validateReport(path.join(dirs.output, 'report.json'), findingIds),
      );
      update(id, { status: 'succeeded', report, endedAt: new Date() });
      return;
    }
    const { proposal, report } = await step(row, planOf(plans, synthesize), signal, async () => ({
      proposal: await validatePatches(
        path.join(dirs.output, 'patches.json'),
        path.join(dirs.input, 'skills'),
        dirs.check,
        findingIds,
      ),
      report: validateReport(path.join(dirs.output, 'report.json'), findingIds),
    }));
    fs.writeFileSync(dirs.proposals, `${JSON.stringify(proposal.files)}\n`);
    db.transaction((tx) => {
      for (const p of proposal.patches) {
        tx.insert(analysisPatches)
          .values({
            analysisId: id,
            file: p.file,
            findingIds: p.findingIds,
            rationale: p.rationale,
            patch: p.patch,
          })
          .run();
      }
    });
    update(id, { status: 'succeeded', report, endedAt: new Date() });
  }

  function finish(id: string, controller: AbortController, error: unknown) {
    const row = get(id);
    const cancelled = controller.signal.aborted && controller.signal.reason === CANCELLED;
    update(id, {
      status: cancelled ? 'cancelled' : 'failed',
      error: cancelled ? null : error instanceof Error ? error.message : String(error),
      endedAt: new Date(),
      steps: row.steps.map((s) =>
        s.status === 'running' || s.status === 'pending' ? { ...s, status: 'cancelled' } : s,
      ),
    });
  }

  // A new analysis row (not yet written)
  function newRow(
    input: NewAnalysisInput,
    s: Scope,
  ): Pick<
    Analysis,
    | 'id'
    | 'engine'
    | 'model'
    | 'variantId'
    | 'analysisVariantId'
    | 'sessionIds'
    | 'status'
    | 'steps'
  > {
    if (s.problem !== null) throw new HttpError(400, s.problem);
    if (s.variant === null && !s.local) throw new HttpError(400, 'No variant');
    const analysisVariantId =
      input.analysisVariantId ?? currentBaseline(db, dataDir, ANALYSIS_WORKFLOW)?.id;
    if (analysisVariantId === undefined) {
      throw new HttpError(
        409,
        `No baseline variant of ${ANALYSIS_WORKFLOW} yet (created when the server starts)`,
      );
    }
    checkedAnalysisVariant(analysisVariantId);
    const model =
      input.model ??
      (input.engine === 'claude' ? models.judge : codexDefaultModel(codexConfigPath));
    const { aspects, synthesize } = stageKeys();
    return {
      id: newAnalysisId(),
      engine: input.engine,
      model,
      variantId: s.variant?.id ?? null,
      analysisVariantId,
      sessionIds: s.sessions.map((x) => x.id),
      status: 'queued',
      steps: [...aspects, synthesize].map(pendingStep),
    };
  }

  return {
    homes,

    defaults(): { claude: string; codex: string; analysisVariantId: string | null } {
      return {
        claude: models.judge,
        codex: codexDefaultModel(codexConfigPath),
        analysisVariantId: currentBaseline(db, dataDir, ANALYSIS_WORKFLOW)?.id ?? null,
      };
    },

    analysisVariants,

    scope,

    // Create the analysis and start it in the background; returns queued or running. Sessions not yet in the dashboard
    // are read in first (Contracts 27), without entering the management table
    async create(input: NewAnalysisInput): Promise<Analysis> {
      const { scope: s, pending } = resolve(input);
      const values = newRow(input, s);
      if (input.engine === 'codex') await requireChecks(['codex']);
      for (const entry of pending) await readForAnalysis(db, entry.engine, entry.file, entry.id);
      db.insert(analyses).values(values).run();
      const row = get(values.id);
      const controller = new AbortController();
      controllers.set(row.id, controller);
      void execute(row.id, controller)
        .then(
          () => undefined,
          (error: unknown) => {
            finish(row.id, controller, error);
          },
        )
        .finally(() => controllers.delete(row.id));
      return get(row.id);
    },

    list(): (Analysis & { variantName: string | null; analysisVariantName: string | null })[] {
      return db
        .select()
        .from(analyses)
        .orderBy(desc(analyses.createdAt), desc(analyses.id))
        .all()
        .map((a) => ({
          ...a,
          variantName: a.variantId === null ? null : variantName(a.variantId),
          analysisVariantName:
            a.analysisVariantId === null ? null : variantName(a.analysisVariantId),
        }));
    },

    get,

    detail(id: string): AnalysisDetail {
      const row = get(id);
      const dirs = analysisLayout(dataDir, id);
      return {
        ...row,
        variantName: row.variantId === null ? null : variantName(row.variantId),
        analysisVariantName:
          row.analysisVariantId === null ? null : variantName(row.analysisVariantId),
        // A deleted variant can no longer be opened in the variant page
        variantDeleted: isDeleted(row.variantId),
        analysisVariantDeleted: isDeleted(row.analysisVariantId),
        sessions: scopeSessions(row.sessionIds),
        findings: db
          .select()
          .from(analysisFindings)
          .where(eq(analysisFindings.analysisId, id))
          .orderBy(asc(analysisFindings.id))
          .all(),
        patches: db
          .select()
          .from(analysisPatches)
          .where(eq(analysisPatches.analysisId, id))
          .orderBy(asc(analysisPatches.id))
          .all(),
        files:
          row.status === 'succeeded' && row.variantId !== null
            ? (JSON.parse(fs.readFileSync(dirs.proposals, 'utf8')) as FileProposal[])
            : [],
        optimizeDrafts: db
          .select({ id: workflowDrafts.id, liveId: workflowDrafts.liveId })
          .from(workflowDrafts)
          .where(eq(workflowDrafts.analysisId, id))
          .orderBy(asc(workflowDrafts.createdAt))
          .all(),
      };
    },

    // Stop all engine processes
    cancel(id: string): Analysis {
      const row = get(id);
      const controller = controllers.get(id);
      if (controller === undefined || (row.status !== 'queued' && row.status !== 'running')) {
        throw new HttpError(409, `Analysis ${id} is not in progress: ${row.status}`);
      }
      controller.abort(CANCELLED);
      return get(id);
    },

    // Save as variant (Contracts 15.3, 19.3): derive a draft from the bound variant, write the accepted and edited
    // content, record parent and analysis_id; name and description are required, not built, status draft
    saveVariant(
      id: string,
      input: { name: string; description: string; files: { path: string; content: string }[] },
    ): Variant {
      const row = get(id);
      if (row.status !== 'succeeded') throw new HttpError(409, `Analysis ${id} has not succeeded`);
      if (row.variantId === null)
        throw new HttpError(
          409,
          `Analysis ${id} analysed local-machine sessions and has no proposed changes`,
        );
      const name = variants.checkName(input.name);
      const description = variants.checkDescription(input.description);
      const proposals = new Set(
        (
          JSON.parse(
            fs.readFileSync(analysisLayout(dataDir, id).proposals, 'utf8'),
          ) as FileProposal[]
        ).map((f) => f.path),
      );
      const outside = input.files.filter((f) => !proposals.has(f.path));
      if (outside.length > 0) {
        throw new HttpError(
          400,
          `These files are not in the proposed changes: ${outside.map((f) => f.path).join(', ')}`,
        );
      }
      const created = variants.derive(row.variantId, { name });
      for (const f of input.files) variants.writeFile(created.id, f.path, f.content);
      db.update(variantsTable)
        .set({ analysisId: id, description })
        .where(eq(variantsTable.id, created.id))
        .run();
      return variants.get(created.id);
    },

    // Server shutdown: stop analyses in progress
    async shutdown() {
      const ids = [...controllers.keys()];
      for (const c of controllers.values()) c.abort(CANCELLED);
      for (const id of ids) {
        while (controllers.has(id)) await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
  };
}

export type Insights = ReturnType<typeof createInsights>;
