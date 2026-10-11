import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';
import { config } from '../src/config.js';
import { closeLinearClient, readTicket } from '../src/external/linear.js';
import { featureDir } from '../src/stages/lfg.js';

// 端到端：对正在运行的 dashboard 服务（config.port，即 WFD_PORT，默认与服务端相同）发真实请求
// 用法：tsx scripts/e2e-runs.ts lfg|takeover|ic <variantId> [taskId]
const base = `http://127.0.0.1:${String(config.port)}/api`;
const outDir = path.join(config.repoRoot, '.work', 'e2e');
fs.mkdirSync(outDir, { recursive: true });

const [scenario, variantId, taskArg] = process.argv.slice(2);
if (scenario === undefined || variantId === undefined) {
  throw new Error('用法：tsx scripts/e2e-runs.ts lfg|takeover|ic <variantId> [taskId]');
}

const StageView = z.looseObject({ stage: z.string(), status: z.string() });
const CycleView = z.looseObject({ stages: z.array(StageView) });
const Question = z.looseObject({
  question: z.string(),
  options: z.array(z.looseObject({ label: z.string() })),
});
const Pending = z.looseObject({
  kind: z.string(),
  text: z.string().optional(),
  questions: z.array(Question).optional(),
});
const Run = z.looseObject({
  id: z.string(),
  status: z.string(),
  sessionId: z.string(),
  mode: z.string(),
  humanIntervened: z.boolean(),
  error: z.string().nullable(),
  currentStage: StageView.nullable(),
  pending: Pending.nullable(),
  costUsd: z.number(),
  durationMs: z.number().nullable(),
  costs: z.record(z.enum(['agent', 'simulatedUser', 'grading', 'total']), z.number()),
  messages: z.array(z.looseObject({ seq: z.number(), role: z.string(), content: z.string() })),
  artifacts: z.array(
    z.looseObject({ kind: z.string(), location: z.string(), snapshot: z.string().nullable() }),
  ),
  // 每个 workflow 是轮次的数组；一个 run 只有一轮
  stages: z.looseObject({ lfg: z.array(CycleView), ic: z.array(CycleView) }).nullable(),
  links: z.record(z.enum(['repo', 'ticket', 'pr', 'vault']), z.string().nullable()),
});
type Run = z.infer<typeof Run>;

async function api(method: string, url: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${base}${url}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${url} → ${String(response.status)} ${text}`);
  return JSON.parse(text);
}

const getRun = async (id: string) => Run.parse(await api('GET', `/runs/${id}`));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const terminal = new Set(['succeeded', 'failed', 'cancelled']);
const started = Date.now();
const elapsed = () => `${String(Math.round((Date.now() - started) / 1000))}s`;

// 唯一一轮的阶段
function stagesOf(run: Run, workflow: 'lfg' | 'ic') {
  return run.stages?.[workflow][0]?.stages ?? [];
}

function stageLine(run: Run) {
  const lfg = stagesOf(run, 'lfg');
  const stages = lfg.length > 0 ? lfg : stagesOf(run, 'ic');
  return stages.map((s) => `${s.stage}:${s.status}`).join(' ');
}

let lastLine = '';
function progress(run: Run) {
  const line = `${run.status} ${run.mode} stage=[${stageLine(run)}] msgs=${String(run.messages.length)} pending=${run.pending?.kind ?? '-'} cost=$${run.costUsd.toFixed(2)}`;
  if (line !== lastLine) console.log(`[${elapsed()}] ${run.id} ${line}`);
  lastLine = line;
}

async function waitRun(id: string, until: (run: Run) => boolean, timeoutMs: number): Promise<Run> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await getRun(id);
    progress(run);
    if (until(run)) return run;
    if (terminal.has(run.status)) {
      throw new Error(`run ${id} 已结束（${run.status}：${String(run.error)}），条件未满足`);
    }
    if (Date.now() > deadline) throw new Error(`等待 run ${id} 超时`);
    await sleep(5_000);
  }
}

async function createBatch(taskId: string, repeats: number): Promise<string[]> {
  const batch = z
    .object({ id: z.string(), runList: z.array(z.object({ id: z.string() })) })
    .parse(await api('POST', '/batches', { variantIds: [variantId], taskIds: [taskId], repeats }));
  console.log(`batch ${batch.id}: ${batch.runList.map((r) => r.id).join(', ')}`);
  return batch.runList.map((r) => r.id);
}

function save(name: string, data: unknown) {
  const file = path.join(outDir, `${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`写入 ${file}`);
}

function check(cond: boolean, message: string): void {
  if (!cond) throw new Error(`断言失败：${message}`);
  console.log(`  ✔ ${message}`);
}

async function claudeAlive(sessionId: string): Promise<boolean> {
  // 模式以 -- 开头，要放在 -- 之后，否则 pgrep 把它当作选项。退出码 0 为找到、1 为没有，其余是 pgrep 自身出错
  const result = await execa('pgrep', ['-f', '--', `--session-id ${sessionId}`], {
    reject: false,
  });
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`pgrep 退出码 ${String(result.exitCode)}：${result.stderr}`);
  }
  return result.exitCode === 0;
}

async function lfg() {
  const [id] = await createBatch(taskArg ?? 'lfg-calculator', 1);
  if (id === undefined) throw new Error('batch 没有 run');
  const run = await waitRun(id, (r) => terminal.has(r.status), 6 * 3600_000);
  save(`lfg-${id}`, run);
  check(run.status === 'succeeded', `status succeeded（实际 ${run.status}：${String(run.error)}）`);
  const dir = featureDir(config.vaultDir, config.evalProduct, id);
  for (const file of ['Brief.md', 'Research.md', 'Tickets.md']) {
    check(fs.existsSync(path.join(dir, file)), `vault 中有 ${path.join(dir, file)}`);
  }
  const lfgStages = stagesOf(run, 'lfg');
  check(
    lfgStages.map((s) => `${s.stage}:${s.status}`).join(' ') ===
      'interview:done research:done plan:done ticketing:done',
    `stage_spans 依次完成：${stageLine(run)}`,
  );
  const tickets = run.artifacts.find((a) => a.kind === 'tickets')?.snapshot ?? '';
  const identifiers = [...new Set(tickets.match(/\bTXE-\d+\b/g) ?? [])];
  check(identifiers.length >= 2, `Tickets.md 列出 epic 与工单：${identifiers.join(', ')}`);
  for (const identifier of identifiers) {
    const ticket = await readTicket(identifier);
    console.log(`    ${identifier} ${ticket.status} ${ticket.url}`);
  }
  await closeLinearClient();
  const roles = run.messages.map((m) => m.role);
  check(
    roles.includes('agent') && roles.includes('simulated_user'),
    `run_messages 有问答：agent ${String(roles.filter((r) => r === 'agent').length)} 条，simulated_user ${String(roles.filter((r) => r === 'simulated_user').length)} 条`,
  );
  const { agent, simulatedUser, grading } = run.costs;
  console.log(`  成本：${JSON.stringify(run.costs)}`);
  check(agent > 0 && simulatedUser > 0 && grading > 0, '成本 agent / 模拟用户 / 评分都有值');
  console.log(`耗时 ${String(run.durationMs)}ms，花费 $${run.costs.total.toFixed(2)}`);
}

async function takeover() {
  const previous = await api('GET', '/settings');
  await api('PUT', '/settings', { ...(previous as object), runConcurrency: 1 });
  const [a, b] = await createBatch(taskArg ?? 'lfg-calculator', 2);
  if (a === undefined || b === undefined) throw new Error('batch 应有两个 run');
  const second = await getRun(b);
  check(second.status === 'queued', `并发为 1 时第二个 run 排队（${second.status}）`);

  // agent 第一轮结束前接管，第一个提问由页面回答
  await waitRun(a, (r) => r.status === 'running', 15 * 60_000);
  await api('POST', `/runs/${a}/takeover`);
  let run = await waitRun(a, (r) => r.pending !== null, 20 * 60_000);
  check(run.mode === 'human' && run.humanIntervened, 'takeover 后 mode human，human_intervened 真');
  check(run.currentStage?.stage !== 'research', `提问发生在 interview 阶段（${stageLine(run)}）`);
  const pending = run.pending;
  if (pending === null) throw new Error('pending 不应为空');
  if (pending.kind === 'text') {
    await api('POST', `/runs/${a}/reply`, {
      text: '主要是我们学校初一到初三的学生在机房用，我上课也会在投影上演示。别的你接着问吧。',
    });
  } else {
    const answers = Object.fromEntries(
      (pending.questions ?? []).map((q) => [q.question, q.options[0]?.label ?? '按你的建议']),
    );
    await api('POST', `/runs/${a}/answer`, { answers });
  }
  run = await getRun(a);
  const answeredByHuman = run.messages.some((m) => m.role === 'human');
  check(answeredByHuman, 'run_messages 中有 human 的回答');
  await api('POST', `/runs/${a}/release`);
  run = await waitRun(a, (r) => r.messages.some((m) => m.role === 'simulated_user'), 30 * 60_000);
  const resumed = run.mode === 'simulated' && run.humanIntervened;
  check(resumed, 'release 后由模拟用户回答，human_intervened 保持为真');

  await api('POST', `/runs/${b}/cancel`);
  check((await getRun(b)).status === 'cancelled', '排队中的 run 直接取消');

  const sessionId = run.sessionId;
  check(await claudeAlive(sessionId), '取消前 claude 进程在运行');
  const cancelStarted = Date.now();
  await api('POST', `/runs/${a}/cancel`);
  run = await getRun(a);
  const cancelMs = Date.now() - cancelStarted;
  check(run.status === 'cancelled', `取消后 status cancelled（用时 ${String(cancelMs)}ms）`);
  check(!(await claudeAlive(sessionId)), '取消后 claude 进程已退出');
  await api('PUT', '/settings', previous);
  save(`takeover-${a}`, run);
}

async function ic() {
  const [id] = await createBatch(taskArg ?? 'ic-money-format', 1);
  if (id === undefined) throw new Error('batch 没有 run');
  const reachedFixPr = (r: Run) =>
    stagesOf(r, 'ic').some((s) => s.stage === 'fix-pr' && s.status !== 'not-reached');
  let run = await waitRun(id, (r) => reachedFixPr(r) || terminal.has(r.status), 4 * 3600_000);
  console.log(`[${elapsed()}] fix-pr 阶段开始：${stageLine(run)}`);
  // 继续等到 ready-for-review 之后的结束，最多再等 90 分钟
  const deadline = Date.now() + 90 * 60_000;
  while (!terminal.has(run.status) && Date.now() < deadline) {
    await sleep(15_000);
    run = await getRun(id);
    progress(run);
  }
  if (!terminal.has(run.status)) {
    console.log('90 分钟内没有结束，取消');
    await api('POST', `/runs/${id}/cancel`);
    run = await getRun(id);
  }
  save(`ic-${id}`, run);
  const ticket = run.artifacts.find((a) => a.kind === 'ticket');
  check(ticket !== undefined, `工单：${String(ticket?.snapshot)} ${String(ticket?.location)}`);
  check(run.links.repo !== null, `仓库：${String(run.links.repo)}`);
  check(run.links.pr !== null, `PR：${String(run.links.pr)}`);
  console.log(`  PR 状态：${String(run.artifacts.find((a) => a.kind === 'pr')?.snapshot)}`);
  console.log(`  阶段：${stageLine(run)}`);
  console.log(`  status ${run.status}，耗时 ${String(run.durationMs)}ms`);
  console.log(`  成本 ${JSON.stringify(run.costs)}`);
}

const scenarios: Record<string, () => Promise<void>> = { lfg, takeover, ic };
const run = scenarios[scenario];
if (run === undefined) throw new Error(`未知场景 ${scenario}`);
await run();
