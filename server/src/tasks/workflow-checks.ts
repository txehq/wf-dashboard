import { isDeepStrictEqual } from 'node:util';
import { data, Evaluator, Lexer, Parser } from '@actions/expressions';
import type { ContextAccess, Expr, ExprVisitor } from '@actions/expressions/ast';
import picomatch from 'picomatch';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import type { WorkflowAnalysis, WorkflowJob, WorkflowJobStatus } from './import-schema.js';

// The default branch of copied repos (createRunRepo); every agent PR uses it as base
const RUN_BRANCH = 'main';

// Labels of GitHub-hosted runners (docs.github.com/actions/reference/runners/github-hosted-runners and larger-runners)
const HOSTED_LABELS = new Set([
  'ubuntu-slim',
  'ubuntu-latest',
  'ubuntu-26.04',
  'ubuntu-24.04',
  'ubuntu-22.04',
  'ubuntu-26.04-arm',
  'ubuntu-24.04-arm',
  'ubuntu-22.04-arm',
  'windows-latest',
  'windows-2025',
  'windows-2025-vs2026',
  'windows-2022',
  'windows-11-arm',
  'windows-11-vs2026-arm',
  'macos-latest',
  'macos-26',
  'macos-15',
  'macos-14',
  'macos-26-intel',
  'macos-15-intel',
  'xcode-27',
  'macos-latest-large',
  'macos-26-large',
  'macos-15-large',
  'macos-14-large',
  'macos-latest-xlarge',
  'macos-26-xlarge',
  'macos-15-xlarge',
  'macos-14-xlarge',
  'xcode-27-xlarge',
]);
// Retired hosted runners: jobs get no runner
const RETIRED_LABELS = new Set([
  'ubuntu-18.04',
  'ubuntu-20.04',
  'windows-2016',
  'windows-2019',
  'macos-10.15',
  'macos-11',
  'macos-12',
  'macos-12-large',
  'macos-13',
  'macos-13-large',
  'macos-13-xlarge',
]);

// Contexts available in workflow expressions (docs.github.com/actions/reference/workflows-and-actions/contexts)
const CONTEXTS = [
  'github',
  'inputs',
  'vars',
  'needs',
  'strategy',
  'matrix',
  'secrets',
  'steps',
  'job',
  'jobs',
  'runner',
  'env',
];

// The nesting limit of reusable workflows, as on GitHub
const MAX_REUSABLE_DEPTH = 4;

export interface WorkflowFile {
  // Relative to the repo root, e.g. .github/workflows/ci.yml
  path: string;
  content: string;
}

// uses: owner/repo/.github/workflows/x.yml@ref
export interface RemoteWorkflowRef {
  owner: string;
  repository: string;
  path: string;
  version: string;
}

// Reads a reusable workflow from another repo
export type RemoteWorkflowReader = (ref: RemoteWorkflowRef) => Promise<string>;

// Only yml / yaml directly under .github/workflows/, as on GitHub
export const isWorkflowPath = (p: string) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p);

type Value = string | number | boolean | null | Value[] | { [key: string]: Value };
type Combo = Record<string, Value>;

const isObject = (v: unknown): v is Record<string, Value> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

// ${{ … }} in a string (docs.github.com/actions/reference/workflows-and-actions/expressions)
const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;

function hasExpression(value: Value): boolean {
  if (typeof value === 'string') return value.includes('${{');
  if (Array.isArray(value)) return value.some(hasExpression);
  if (isObject(value)) return Object.values(value).some(hasExpression);
  return false;
}

class ContextNames implements ExprVisitor<string[]> {
  visitLiteral(): string[] {
    return [];
  }
  visitUnary(u: { expr: Expr }): string[] {
    return u.expr.accept(this);
  }
  visitBinary(b: { left: Expr; right: Expr }): string[] {
    return [...b.left.accept(this), ...b.right.accept(this)];
  }
  visitLogical(l: { args: Expr[] }): string[] {
    return l.args.flatMap((a) => a.accept(this));
  }
  visitGrouping(g: { group: Expr }): string[] {
    return g.group.accept(this);
  }
  visitContextAccess(c: ContextAccess): string[] {
    return [c.name.lexeme];
  }
  visitIndexAccess(i: { expr: Expr; index: Expr }): string[] {
    return [...i.expr.accept(this), ...i.index.accept(this)];
  }
  visitFunctionCall(f: { args: Expr[] }): string[] {
    return f.args.flatMap((a) => a.accept(this));
  }
}

type Evaluated = { ok: true; value: Value } | { ok: false; reason: string };

// Only expressions using matrix alone are evaluated here; values using other contexts (inputs, github, needs…) are
// known only at run time
function evaluate(expression: string, matrix: Combo): Evaluated {
  const ast = new Parser(new Lexer(expression).lex().tokens, CONTEXTS, []).parse();
  const others = [...new Set(ast.accept(new ContextNames()))].filter((c) => c !== 'matrix');
  if (others.length > 0) {
    return { ok: false, reason: `\${{ ${expression.trim()} }} uses ${others.join(', ')}` };
  }
  const context = JSON.parse(JSON.stringify({ matrix }), data.reviver) as data.Dictionary;
  const result = new Evaluator(ast, context).evaluate();
  return { ok: true, value: JSON.parse(JSON.stringify(result, data.replacer)) as Value };
}

// How an expression's value is written when embedded in a string, as on GitHub (null is an empty string)
const asText = (v: Value): string | null =>
  v === null ? '' : typeof v === 'object' ? null : String(v);

// A string that is a single expression takes its value (which may be a list or an object); otherwise each
// expression's value is embedded in the string
function resolveString(text: string, matrix: Combo): Evaluated {
  const pieces = [...text.matchAll(EXPRESSION)];
  if (pieces.length === 0) return { ok: true, value: text };
  const only = pieces[0];
  if (pieces.length === 1 && only?.[0] === text.trim()) {
    return evaluate(only[1] ?? '', matrix);
  }
  let out = '';
  let last = 0;
  for (const piece of pieces) {
    const r = evaluate(piece[1] ?? '', matrix);
    if (!r.ok) return r;
    const t = asText(r.value);
    if (t === null) return { ok: false, reason: `\${{${piece[1] ?? ''}}} is not a scalar` };
    out += text.slice(last, piece.index) + t;
    last = piece.index + piece[0].length;
  }
  return { ok: true, value: out + text.slice(last) };
}

function resolve(value: Value, matrix: Combo): Evaluated {
  if (typeof value === 'string') return resolveString(value, matrix);
  if (Array.isArray(value)) {
    const out: Value[] = [];
    for (const item of value) {
      const r = resolve(item, matrix);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return { ok: true, value: out };
  }
  if (isObject(value)) {
    const out: Record<string, Value> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = resolve(v, matrix);
      if (!r.ok) return r;
      out[k] = r.value;
    }
    return { ok: true, value: out };
  }
  return { ok: true, value };
}

// An exclude item equals the combination on all its keys (object values match partially)
function matchesPartial(combo: Combo, pattern: Record<string, Value>): boolean {
  return Object.entries(pattern).every(([k, v]) => {
    const actual = combo[k];
    if (actual === undefined) return false;
    if (isObject(v) && isObject(actual)) return matchesPartial(actual, v);
    return isDeepStrictEqual(actual, v);
  });
}

const MatrixEntries = z.array(z.record(z.string(), z.unknown()));

// Matrix expansion (docs.github.com/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations):
// the Cartesian product of the dimensions -> drop combinations matched by exclude -> each include item is added to
// every combination whose original values it does not overwrite, or becomes a new combination when it fits none;
// added values may be overwritten by later includes, original values may not; new combinations from include take no
// later includes
export function expandMatrix(matrix: Record<string, Value>): Combo[] {
  const { include, exclude, ...dimensions } = matrix;
  const includes = (include === undefined ? [] : MatrixEntries.parse(include)) as Combo[];
  const excludes = (exclude === undefined ? [] : MatrixEntries.parse(exclude)) as Combo[];
  let combos: Combo[] = Object.keys(dimensions).length === 0 ? [] : [{}];
  for (const [key, values] of Object.entries(dimensions)) {
    if (!Array.isArray(values)) throw new Error(`matrix.${key} is not a list`);
    combos = combos.flatMap((c) => values.map((v) => ({ ...c, [key]: v })));
  }
  combos = combos.filter((c) => !excludes.some((e) => matchesPartial(c, e)));
  const originals = combos.map((c) => ({ ...c }));
  const added: Combo[] = [];
  for (const item of includes) {
    let merged = false;
    for (const [i, combo] of combos.entries()) {
      const original = originals[i] ?? {};
      const fits = Object.entries(item).every(
        ([k, v]) => original[k] === undefined || isDeepStrictEqual(original[k], v),
      );
      if (fits) {
        Object.assign(combo, item);
        merged = true;
      }
    }
    if (!merged) added.push({ ...item });
  }
  return [...combos, ...added];
}

// A filter can be a string or a list of strings
const Patterns = z
  .union([z.string(), z.array(z.string())])
  .transform((p) => (typeof p === 'string' ? [p] : p))
  .optional();
const EventFilter = z
  .object({
    branches: Patterns,
    'branches-ignore': Patterns,
    tags: Patterns,
    'tags-ignore': Patterns,
    paths: Patterns,
    'paths-ignore': Patterns,
    types: Patterns,
  })
  .loose();
type EventFilter = z.infer<typeof EventFilter>;

// on can be an event name, a list of event names or a mapping (values empty or filters)
const On = z
  .union([z.string(), z.array(z.string()), z.record(z.string(), z.unknown())])
  .transform((on): Record<string, unknown> => {
    if (typeof on === 'string') return { [on]: {} };
    if (Array.isArray(on)) return Object.fromEntries(on.map((e) => [e, {}]));
    return Object.fromEntries(Object.entries(on).map(([e, v]) => [e, v ?? {}]));
  });

const Job = z
  .object({
    name: z.union([z.string(), z.number()]).optional(),
    needs: z
      .union([z.string(), z.array(z.string())])
      .transform((n) => (typeof n === 'string' ? [n] : n))
      .optional(),
    'runs-on': z.unknown().optional(),
    strategy: z.unknown().optional(),
    uses: z.string().optional(),
  })
  .loose()
  .refine((j) => j['runs-on'] !== undefined || j.uses !== undefined, 'has neither runs-on nor uses');
type Job = z.infer<typeof Job>;

const Workflow = z.object({ on: On, jobs: z.record(z.string(), Job) }).loose();
type Workflow = z.infer<typeof Workflow>;

// The yaml 1.2 parse result; YAML errors and structure errors both mean GitHub will not run the workflow
function parseWorkflow(content: string): { ok: true; workflow: Workflow } | { ok: false; errors: string[] } {
  // GitHub workflows are YAML 1.2, where on is not read as a boolean
  const doc = parseDocument(content, { version: '1.2' });
  if (doc.errors.length > 0) return { ok: false, errors: doc.errors.map((e) => e.message) };
  const result = Workflow.safeParse(doc.toJS());
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  return { ok: true, workflow: result.data };
}

function filterMatches(include: string[] | undefined, ignore: string[] | undefined, ref: string) {
  if (include !== undefined) {
    // Later patterns in the list win; patterns starting with ! exclude
    let matched = false;
    for (const pattern of include) {
      if (pattern.startsWith('!')) {
        if (picomatch(pattern.slice(1))(ref)) matched = false;
      } else if (picomatch(pattern)(ref)) {
        matched = true;
      }
    }
    return matched;
  }
  if (ignore !== undefined) return !ignore.some((p) => picomatch(p)(ref));
  return true;
}

// A new commit pushed to the PR head is synchronize; when types lacks opened / synchronize / reopened, ordinary PRs
// do not trigger it
const PR_TYPES = ['opened', 'synchronize', 'reopened'];

type PrTrigger = { on: false; reason: string } | { on: true; pathFiltered: boolean };

function eventFilter(events: Record<string, unknown>, name: string): EventFilter | undefined {
  return name in events ? EventFilter.parse(events[name]) : undefined;
}

function prTrigger(events: Record<string, unknown>): PrTrigger {
  const configs = ['pull_request', 'pull_request_target']
    .map((e) => eventFilter(events, e))
    .filter((c) => c !== undefined);
  if (configs.length === 0) {
    const names = Object.keys(events);
    return {
      on: false,
      reason: `the workflow is triggered only by ${names.length > 0 ? names.join(', ') : '(no events)'} and does not run on PRs`,
    };
  }
  const usable = configs.filter(
    (c) =>
      (c.types === undefined || c.types.some((t) => PR_TYPES.includes(t))) &&
      filterMatches(c.branches, c['branches-ignore'], RUN_BRANCH),
  );
  if (usable.length === 0) {
    return {
      on: false,
      reason: `the pull_request types or branches filter excludes PRs to ${RUN_BRANCH}`,
    };
  }
  return {
    on: true,
    pathFiltered: usable.every((c) => c.paths !== undefined || c['paths-ignore'] !== undefined),
  };
}

// Runs on pushes to main: a push with only a tags filter is not triggered by branch pushes; one with a paths filter
// does not count (pushing the starting code may not hit it)
function pushTrigger(events: Record<string, unknown>): boolean {
  const push = eventFilter(events, 'push');
  if (push === undefined) return false;
  const branchFilter = push.branches !== undefined || push['branches-ignore'] !== undefined;
  const tagFilter = push.tags !== undefined || push['tags-ignore'] !== undefined;
  if (tagFilter && !branchFilter) return false;
  if (push.paths !== undefined || push['paths-ignore'] !== undefined) return false;
  return filterMatches(push.branches, push['branches-ignore'], RUN_BRANCH);
}

type Named = { ok: true; name: string } | { ok: false; reason: string };

// Check name: a name with expressions is evaluated with the matrix; otherwise the matrix values are appended as
// "name (a, b)"
function checkName(name: string, combo: Combo): Named {
  if (hasExpression(name)) {
    const r = resolve(name, combo);
    if (!r.ok) return { ok: false, reason: `job name ${r.reason}` };
    const text = asText(r.value);
    if (text === null) return { ok: false, reason: 'job name is not a string' };
    return { ok: true, name: text };
  }
  const values = Object.values(combo);
  if (values.length === 0) return { ok: true, name };
  const texts = values.map((v) => (v === null ? null : asText(v)));
  if (texts.some((t) => t === null)) {
    return { ok: false, reason: 'a matrix value is not a scalar, so the check name cannot be determined' };
  }
  return { ok: true, name: `${name} (${texts.join(', ')})` };
}

type Runner =
  | { kind: 'hosted' | 'copy' | 'unavailable' | 'retired'; labels: string }
  | { kind: 'unresolved'; reason: string };

const Labels = z.union([z.string(), z.array(z.string())]).transform((l) => (typeof l === 'string' ? [l] : l));

// Runners available in copies (Contracts section 13): every runs-on label is a GitHub-hosted runner label,
// self-hosted, or in copyRunnerLabels (the txehq organisation's self-hosted runners). Runner groups are runners the
// organisation configures separately and are out of scope
function runner(runsOn: unknown, combo: Combo, copyRunnerLabels: string[]): Runner {
  const r = resolve(runsOn as Value, combo);
  if (!r.ok) return { kind: 'unresolved', reason: `runs-on ${r.reason}` };
  const value = r.value;
  if (isObject(value)) {
    const group = typeof value.group === 'string' ? `group: ${value.group}` : null;
    const labels = value.labels === undefined ? [] : Labels.parse(value.labels);
    return {
      kind: 'unavailable',
      labels: [group, ...labels].filter((l) => l !== null).join(', '),
    };
  }
  const labels = Labels.parse(value);
  const text = labels.join(', ');
  if (labels.some((l) => RETIRED_LABELS.has(l))) return { kind: 'retired', labels: text };
  if (labels.length === 0) return { kind: 'unresolved', reason: 'runs-on is empty' };
  if (labels.every((l) => HOSTED_LABELS.has(l))) return { kind: 'hosted', labels: text };
  const allowed = (l: string) =>
    HOSTED_LABELS.has(l) || l === 'self-hosted' || copyRunnerLabels.includes(l);
  return { kind: labels.every(allowed) ? 'copy' : 'unavailable', labels: text };
}

interface Instance {
  // Which jobs this instance belongs to: itself and the reusable workflow job calling it (needs may point at any of
  // them)
  keys: string[];
  workflow: string;
  jobId: string;
  needs: string[];
  checkName: string | null;
  runsOn: string | null;
  intrinsic: { status: 'ok' | 'runner-unavailable' | 'retired' | 'unresolved'; reason: string };
}

type Combos = { ok: true; combos: Combo[] } | { ok: false; reason: string };

function combos(strategy: unknown): Combos {
  if (strategy === undefined) return { ok: true, combos: [{}] };
  if (!isObject(strategy)) return { ok: false, reason: 'strategy uses values known only at run time' };
  const matrix = strategy.matrix;
  if (matrix === undefined) return { ok: true, combos: [{}] };
  if (hasExpression(matrix)) return { ok: false, reason: 'strategy.matrix uses values known only at run time' };
  if (!isObject(matrix)) return { ok: false, reason: 'strategy.matrix is not a mapping' };
  return { ok: true, combos: expandMatrix(matrix) };
}

const intrinsicOf = (r: Runner): Instance['intrinsic'] => {
  switch (r.kind) {
    case 'hosted':
      return { status: 'ok', reason: `GitHub-hosted runner ${r.labels}` };
    case 'copy':
      return { status: 'ok', reason: `self-hosted runner ${r.labels} available to copies (copyRunnerLabels in Settings)` };
    case 'unavailable':
      return {
        status: 'runner-unavailable',
        reason: `runs-on ${r.labels} is not among the runners available to copies (GitHub-hosted runners and copyRunnerLabels in Settings)`,
      };
    case 'retired':
      return { status: 'retired', reason: `runs-on ${r.labels} is a hosted runner GitHub has retired` };
    case 'unresolved':
      return { status: 'unresolved', reason: r.reason };
  }
};

const REMOTE_USES = /^([^/]+)\/([^/]+)\/(.+)@(.+)$/;

interface Context {
  workflow: string;
  files: WorkflowFile[];
  readRemote: RemoteWorkflowReader;
  copyRunnerLabels: string[];
}

// The jobs of a reusable workflow; the reason when it cannot be read or is invalid
async function calledJobs(uses: string, ctx: Context): Promise<{ ok: true; jobs: Record<string, Job> } | { ok: false; reason: string }> {
  let content: string;
  if (uses.startsWith('./')) {
    const local = ctx.files.find((f) => f.path === uses.slice(2));
    if (local === undefined) return { ok: false, reason: `the called workflow ${uses} is not in the repo` };
    content = local.content;
  } else {
    const m = REMOTE_USES.exec(uses);
    if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined || m[4] === undefined) {
      return { ok: false, reason: `uses is not a reusable workflow reference: ${uses}` };
    }
    content = await ctx.readRemote({ owner: m[1], repository: m[2], path: m[3], version: m[4] });
  }
  const parsed = parseWorkflow(content);
  if (!parsed.ok) return { ok: false, reason: `the called workflow ${uses} is invalid: ${parsed.errors.join('; ')}` };
  return { ok: true, jobs: parsed.workflow.jobs };
}

// Every instance of a job: the matrix expanded; a reusable workflow job expands to the jobs of the called workflow
// (check name "caller / callee")
async function instances(
  id: string,
  job: Job,
  ctx: Context,
  caller: { keys: string[]; name: string; depth: number } | null,
): Promise<Instance[]> {
  const scope = caller?.keys[0];
  const local = (jobId: string) => (scope === undefined ? jobId : `${scope}/${jobId}`);
  const jobId = local(id);
  const keys = [jobId, ...(caller?.keys ?? [])];
  const needs = (job.needs ?? []).map(local);
  const unresolved = (reason: string): Instance[] => [
    {
      keys,
      workflow: ctx.workflow,
      jobId,
      needs,
      checkName: null,
      runsOn: null,
      intrinsic: { status: 'unresolved', reason },
    },
  ];
  const expanded = combos(job.strategy);
  if (!expanded.ok) return unresolved(expanded.reason);
  const name = job.name === undefined ? id : String(job.name);
  const out: Instance[] = [];
  for (const combo of expanded.combos) {
    const named = checkName(name, combo);
    if (!named.ok) {
      out.push(...unresolved(named.reason));
      continue;
    }
    const fullName = caller === null ? named.name : `${caller.name} / ${named.name}`;
    if (job.uses !== undefined) {
      const depth = (caller?.depth ?? 0) + 1;
      if (depth > MAX_REUSABLE_DEPTH) {
        out.push(...unresolved(`reusable workflows nest deeper than ${String(MAX_REUSABLE_DEPTH)} levels`));
        continue;
      }
      const called = await calledJobs(job.uses, ctx);
      if (!called.ok) {
        out.push(...unresolved(called.reason));
        continue;
      }
      for (const [innerId, inner] of Object.entries(called.jobs)) {
        const nested = await instances(innerId, inner, ctx, { keys, name: fullName, depth });
        // Jobs in the called workflow also wait for the caller's needs
        out.push(...nested.map((i) => ({ ...i, needs: [...i.needs, ...needs] })));
      }
      continue;
    }
    const r = runner(job['runs-on'], combo, ctx.copyRunnerLabels);
    out.push({
      keys,
      workflow: ctx.workflow,
      jobId,
      needs,
      checkName: fullName,
      runsOn: r.kind === 'unresolved' ? null : r.labels,
      intrinsic: intrinsicOf(r),
    });
  }
  return out;
}

// Static analysis of workflows: which jobs can run on PRs in the copied repo (Contracts section 13);
// copyRunnerLabels are the self-hosted runner labels available to copies from Settings
export async function analyzeWorkflows(
  files: WorkflowFile[],
  readRemote: RemoteWorkflowReader,
  copyRunnerLabels: string[],
): Promise<WorkflowAnalysis> {
  const jobs: WorkflowJob[] = [];
  const workflows = files
    .filter((f) => isWorkflowPath(f.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  for (const file of workflows) {
    const parsed = parseWorkflow(file.content);
    if (!parsed.ok) {
      jobs.push({
        workflow: file.path,
        jobId: '*',
        checkName: null,
        runsOn: null,
        status: 'invalid',
        reason: `GitHub will not run this workflow: ${parsed.errors.join('; ')}`,
        onPush: false,
      });
      continue;
    }
    const events = parsed.workflow.on;
    const ctx: Context = { workflow: file.path, files, readRemote, copyRunnerLabels };
    const all: Instance[] = [];
    for (const [id, job] of Object.entries(parsed.workflow.jobs)) {
      all.push(...(await instances(id, job, ctx, null)));
    }
    // When a job in needs (any instance) cannot run, this one does not either; transitive along dependencies
    const runnable = new Map<string, boolean>();
    const canRun = (key: string, seen: Set<string>): boolean => {
      const known = runnable.get(key);
      if (known !== undefined) return known;
      if (seen.has(key)) throw new Error(`${file.path} has a needs cycle: ${key}`);
      const own = all.filter((i) => i.keys.includes(key));
      if (own.length === 0) throw new Error(`${file.path}: needs points at a missing job: ${key}`);
      const next = new Set(seen).add(key);
      const ok = own.every(
        (i) => i.intrinsic.status === 'ok' && i.needs.every((n) => canRun(n, next)),
      );
      runnable.set(key, ok);
      return ok;
    };
    const pr = prTrigger(events);
    const onPush = pushTrigger(events);
    for (const i of all) {
      const blockedBy = i.needs.filter((n) => !canRun(n, new Set()));
      let status: WorkflowJobStatus;
      let reason: string;
      // A job with no runner in the copy never runs whatever triggers it, so it is listed before trigger conditions
      if (i.intrinsic.status === 'runner-unavailable' || i.intrinsic.status === 'retired') {
        status = i.intrinsic.status;
        reason = i.intrinsic.reason;
      } else if (!pr.on) {
        status = 'not-on-pr';
        reason = pr.reason;
      } else if (pr.pathFiltered) {
        status = 'path-filtered';
        reason = 'pull_request has a paths filter and runs only when particular paths change';
      } else if (i.intrinsic.status === 'unresolved') {
        status = 'unresolved';
        reason = i.intrinsic.reason;
      } else if (blockedBy.length > 0) {
        status = 'blocked';
        reason = `${blockedBy.join(', ')} in needs cannot run in the copy`;
      } else {
        status = 'required';
        reason = i.intrinsic.reason;
      }
      jobs.push({
        workflow: i.workflow,
        jobId: i.jobId,
        checkName: i.checkName,
        runsOn: i.runsOn,
        status,
        reason,
        onPush: onPush && i.intrinsic.status === 'ok' && blockedBy.length === 0,
      });
    }
  }
  const requiredChecks = [
    ...new Set(
      jobs.flatMap((j) => (j.status === 'required' && j.checkName !== null ? [j.checkName] : [])),
    ),
  ];
  return { jobs, requiredChecks };
}
