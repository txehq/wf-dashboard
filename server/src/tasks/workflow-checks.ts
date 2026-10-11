import { isDeepStrictEqual } from 'node:util';
import { data, Evaluator, Lexer, Parser } from '@actions/expressions';
import type { ContextAccess, Expr, ExprVisitor } from '@actions/expressions/ast';
import picomatch from 'picomatch';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import type { WorkflowAnalysis, WorkflowJob, WorkflowJobStatus } from './import-schema.js';

// 副本仓库（createRunRepo）的默认分支，agent 的 PR 都以它为 base
const RUN_BRANCH = 'main';

// GitHub 托管 runner 的标签（docs.github.com/actions/reference/runners/github-hosted-runners 与 larger-runners）
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
// 已停用的托管 runner：job 拿不到 runner
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

// workflow 表达式可用的 context（docs.github.com/actions/reference/workflows-and-actions/contexts）
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

// reusable workflow 的嵌套层数上限，与 GitHub 相同
const MAX_REUSABLE_DEPTH = 4;

export interface WorkflowFile {
  // 相对仓库根目录，例如 .github/workflows/ci.yml
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

// 读取其他仓库的 reusable workflow
export type RemoteWorkflowReader = (ref: RemoteWorkflowRef) => Promise<string>;

// 只认 .github/workflows/ 下一层的 yml / yaml，与 GitHub 相同
export const isWorkflowPath = (p: string) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p);

type Value = string | number | boolean | null | Value[] | { [key: string]: Value };
type Combo = Record<string, Value>;

const isObject = (v: unknown): v is Record<string, Value> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

// 字符串中的 ${{ … }}（docs.github.com/actions/reference/workflows-and-actions/expressions）
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

// 只用 matrix 的表达式在这里求值；用到其他 context（inputs、github、needs…）的值只有运行时才知道
function evaluate(expression: string, matrix: Combo): Evaluated {
  const ast = new Parser(new Lexer(expression).lex().tokens, CONTEXTS, []).parse();
  const others = [...new Set(ast.accept(new ContextNames()))].filter((c) => c !== 'matrix');
  if (others.length > 0) {
    return { ok: false, reason: `\${{ ${expression.trim()} }} 用到 ${others.join('、')}` };
  }
  const context = JSON.parse(JSON.stringify({ matrix }), data.reviver) as data.Dictionary;
  const result = new Evaluator(ast, context).evaluate();
  return { ok: true, value: JSON.parse(JSON.stringify(result, data.replacer)) as Value };
}

// 表达式的值嵌入字符串时的写法，与 GitHub 相同（null 为空字符串）
const asText = (v: Value): string | null =>
  v === null ? '' : typeof v === 'object' ? null : String(v);

// 整个字符串只有一个表达式时取它的值（可以是列表或对象）；否则把每个表达式的值嵌入字符串
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
    if (t === null) return { ok: false, reason: `\${{${piece[1] ?? ''}}} 的值不是标量` };
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

// exclude 的一项与组合中对应的键全部相等（对象值按部分匹配）
function matchesPartial(combo: Combo, pattern: Record<string, Value>): boolean {
  return Object.entries(pattern).every(([k, v]) => {
    const actual = combo[k];
    if (actual === undefined) return false;
    if (isObject(v) && isObject(actual)) return matchesPartial(actual, v);
    return isDeepStrictEqual(actual, v);
  });
}

const MatrixEntries = z.array(z.record(z.string(), z.unknown()));

// matrix 的展开规则（docs.github.com/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations）：
// 各维度取笛卡尔积 → 去掉 exclude 匹配的组合 → include 的每一项加进不改写原始值的每个组合，一个都加不进时成为新组合；
// 加进来的值可以被之后的 include 改写，原始值不会；include 产生的新组合不再接受之后的 include
export function expandMatrix(matrix: Record<string, Value>): Combo[] {
  const { include, exclude, ...dimensions } = matrix;
  const includes = (include === undefined ? [] : MatrixEntries.parse(include)) as Combo[];
  const excludes = (exclude === undefined ? [] : MatrixEntries.parse(exclude)) as Combo[];
  let combos: Combo[] = Object.keys(dimensions).length === 0 ? [] : [{}];
  for (const [key, values] of Object.entries(dimensions)) {
    if (!Array.isArray(values)) throw new Error(`matrix.${key} 不是列表`);
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

// 过滤条件可以写成一个字符串或字符串列表
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

// on 可以是事件名、事件名列表或映射（值为空或过滤条件）
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
  .refine((j) => j['runs-on'] !== undefined || j.uses !== undefined, '没有 runs-on 也没有 uses');
type Job = z.infer<typeof Job>;

const Workflow = z.object({ on: On, jobs: z.record(z.string(), Job) }).loose();
type Workflow = z.infer<typeof Workflow>;

// yaml 1.2 的解析结果；YAML 错误与结构错误都是 GitHub 不会运行的 workflow
function parseWorkflow(content: string): { ok: true; workflow: Workflow } | { ok: false; errors: string[] } {
  // GitHub 的 workflow 是 YAML 1.2，on 不会被读成布尔值
  const doc = parseDocument(content, { version: '1.2' });
  if (doc.errors.length > 0) return { ok: false, errors: doc.errors.map((e) => e.message) };
  const result = Workflow.safeParse(doc.toJS());
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((i) => `${i.path.join('.') || '（整体）'}：${i.message}`),
    };
  }
  return { ok: true, workflow: result.data };
}

function filterMatches(include: string[] | undefined, ignore: string[] | undefined, ref: string) {
  if (include !== undefined) {
    // 列表中靠后的模式优先，! 开头的模式排除
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

// PR 的 head 推送新 commit 时是 synchronize；types 不含 opened / synchronize / reopened 时普通 PR 不触发
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
      reason: `workflow 只由 ${names.length > 0 ? names.join('、') : '（没有事件）'} 触发，PR 上不会运行`,
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
      reason: `pull_request 的 types 或 branches 过滤不包含指向 ${RUN_BRANCH} 的 PR`,
    };
  }
  return {
    on: true,
    pathFiltered: usable.every((c) => c.paths !== undefined || c['paths-ignore'] !== undefined),
  };
}

// 推送到 main 时运行：只定义了 tags 过滤的 push 不由分支推送触发；带 paths 过滤的不算（起始代码的推送不一定命中）
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

// check 名：name 含表达式时按 matrix 求值；否则 matrix 的值以 "name (a, b)" 附在后面
function checkName(name: string, combo: Combo): Named {
  if (hasExpression(name)) {
    const r = resolve(name, combo);
    if (!r.ok) return { ok: false, reason: `job 名 ${r.reason}` };
    const text = asText(r.value);
    if (text === null) return { ok: false, reason: 'job 名不是字符串' };
    return { ok: true, name: text };
  }
  const values = Object.values(combo);
  if (values.length === 0) return { ok: true, name };
  const texts = values.map((v) => (v === null ? null : asText(v)));
  if (texts.some((t) => t === null)) {
    return { ok: false, reason: 'matrix 的值不是标量，check 名无法确定' };
  }
  return { ok: true, name: `${name} (${texts.join(', ')})` };
}

type Runner =
  | { kind: 'hosted' | 'self-hosted' | 'retired'; labels: string }
  | { kind: 'unresolved'; reason: string };

const Labels = z.union([z.string(), z.array(z.string())]).transform((l) => (typeof l === 'string' ? [l] : l));

function runner(runsOn: unknown, combo: Combo): Runner {
  const r = resolve(runsOn as Value, combo);
  if (!r.ok) return { kind: 'unresolved', reason: `runs-on ${r.reason}` };
  const value = r.value;
  if (isObject(value)) {
    const group = typeof value.group === 'string' ? `group: ${value.group}` : null;
    const labels = value.labels === undefined ? [] : Labels.parse(value.labels);
    // runner group 是组织配置的 runner（自托管或组织的 larger runner），副本中没有
    return {
      kind: 'self-hosted',
      labels: [group, ...labels].filter((l) => l !== null).join(', '),
    };
  }
  const labels = Labels.parse(value);
  const text = labels.join(', ');
  const only = labels.length === 1 ? labels[0] : undefined;
  if (only !== undefined && HOSTED_LABELS.has(only)) return { kind: 'hosted', labels: text };
  if (only !== undefined && RETIRED_LABELS.has(only)) return { kind: 'retired', labels: text };
  return { kind: 'self-hosted', labels: text };
}

interface Instance {
  // 这个实例属于哪些 job：自己，以及调用它的 reusable workflow job（needs 可以指向其中任何一个）
  keys: string[];
  workflow: string;
  jobId: string;
  needs: string[];
  checkName: string | null;
  runsOn: string | null;
  intrinsic: { status: 'ok' | 'self-hosted' | 'retired' | 'unresolved'; reason: string };
}

type Combos = { ok: true; combos: Combo[] } | { ok: false; reason: string };

function combos(strategy: unknown): Combos {
  if (strategy === undefined) return { ok: true, combos: [{}] };
  if (!isObject(strategy)) return { ok: false, reason: 'strategy 用到运行时才知道的值' };
  const matrix = strategy.matrix;
  if (matrix === undefined) return { ok: true, combos: [{}] };
  if (hasExpression(matrix)) return { ok: false, reason: 'strategy.matrix 用到运行时才知道的值' };
  if (!isObject(matrix)) return { ok: false, reason: 'strategy.matrix 不是映射' };
  return { ok: true, combos: expandMatrix(matrix) };
}

const intrinsicOf = (r: Runner): Instance['intrinsic'] => {
  switch (r.kind) {
    case 'hosted':
      return { status: 'ok', reason: `GitHub 托管 runner ${r.labels}` };
    case 'self-hosted':
      return {
        status: 'self-hosted',
        reason: `runs-on ${r.labels} 不是 GitHub 托管 runner，副本仓库中没有这个 runner`,
      };
    case 'retired':
      return { status: 'retired', reason: `runs-on ${r.labels} 是 GitHub 已停用的托管 runner` };
    case 'unresolved':
      return { status: 'unresolved', reason: r.reason };
  }
};

const REMOTE_USES = /^([^/]+)\/([^/]+)\/(.+)@(.+)$/;

interface Context {
  workflow: string;
  files: WorkflowFile[];
  readRemote: RemoteWorkflowReader;
}

// reusable workflow 的 jobs；读不到或不合法时给出原因
async function calledJobs(uses: string, ctx: Context): Promise<{ ok: true; jobs: Record<string, Job> } | { ok: false; reason: string }> {
  let content: string;
  if (uses.startsWith('./')) {
    const local = ctx.files.find((f) => f.path === uses.slice(2));
    if (local === undefined) return { ok: false, reason: `仓库中没有被调用的 workflow ${uses}` };
    content = local.content;
  } else {
    const m = REMOTE_USES.exec(uses);
    if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined || m[4] === undefined) {
      return { ok: false, reason: `uses 不是 reusable workflow 的引用：${uses}` };
    }
    content = await ctx.readRemote({ owner: m[1], repository: m[2], path: m[3], version: m[4] });
  }
  const parsed = parseWorkflow(content);
  if (!parsed.ok) return { ok: false, reason: `被调用的 workflow ${uses} 不合法：${parsed.errors.join('；')}` };
  return { ok: true, jobs: parsed.workflow.jobs };
}

// 一个 job 的全部实例：matrix 展开；reusable workflow 的 job 展开为被调用 workflow 中的 job（check 名 "调用方 / 被调用方"）
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
        out.push(...unresolved(`reusable workflow 嵌套超过 ${String(MAX_REUSABLE_DEPTH)} 层`));
        continue;
      }
      const called = await calledJobs(job.uses, ctx);
      if (!called.ok) {
        out.push(...unresolved(called.reason));
        continue;
      }
      for (const [innerId, inner] of Object.entries(called.jobs)) {
        const nested = await instances(innerId, inner, ctx, { keys, name: fullName, depth });
        // 被调用 workflow 中的 job 也要等调用方的 needs
        out.push(...nested.map((i) => ({ ...i, needs: [...i.needs, ...needs] })));
      }
      continue;
    }
    const r = runner(job['runs-on'], combo);
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

// 静态分析 workflow：哪些 job 能在副本仓库的 PR 上运行（Contracts 第 13 节）
export async function analyzeWorkflows(
  files: WorkflowFile[],
  readRemote: RemoteWorkflowReader,
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
        reason: `GitHub 不会运行这个 workflow：${parsed.errors.join('；')}`,
        onPush: false,
      });
      continue;
    }
    const events = parsed.workflow.on;
    const ctx: Context = { workflow: file.path, files, readRemote };
    const all: Instance[] = [];
    for (const [id, job] of Object.entries(parsed.workflow.jobs)) {
      all.push(...(await instances(id, job, ctx, null)));
    }
    // needs 的 job（任一实例）不能运行时，它也不会运行；按依赖传递
    const runnable = new Map<string, boolean>();
    const canRun = (key: string, seen: Set<string>): boolean => {
      const known = runnable.get(key);
      if (known !== undefined) return known;
      if (seen.has(key)) throw new Error(`${file.path} 的 needs 有环：${key}`);
      const own = all.filter((i) => i.keys.includes(key));
      if (own.length === 0) throw new Error(`${file.path} 中 needs 指向不存在的 job：${key}`);
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
      // 副本中没有 runner 的 job 无论如何触发都不会运行，先于触发条件列出
      if (i.intrinsic.status === 'self-hosted' || i.intrinsic.status === 'retired') {
        status = i.intrinsic.status;
        reason = i.intrinsic.reason;
      } else if (!pr.on) {
        status = 'not-on-pr';
        reason = pr.reason;
      } else if (pr.pathFiltered) {
        status = 'path-filtered';
        reason = 'pull_request 带 paths 过滤，只在改动特定路径时运行';
      } else if (i.intrinsic.status === 'unresolved') {
        status = 'unresolved';
        reason = i.intrinsic.reason;
      } else if (blockedBy.length > 0) {
        status = 'blocked';
        reason = `needs 的 ${blockedBy.join('、')} 无法在副本中运行`;
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
