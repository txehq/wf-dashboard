import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { batches, runs, variants } from '../../src/db/schema.js';
import { git } from '../helpers/magi-repo.js';
import { sessionLines } from '../helpers/session-copies.js';
import {
  client,
  type Detail,
  type MagiApp,
  type MagiView,
  sleep,
  startMagiApp,
  until,
} from './harness.js';

// 部署（Contracts 23.5），基础档：主仓库与 worktree 是测试自己建的本地 git 仓库，检查命令换成一条快的真实命令
// （node 运行 check.mjs：有 fail 文件时输出原文并以 1 退出）。每一步失败时的原文；六步都成功后合并、备份、
// 调用重新启动；之后用同一个数据库再启动一次服务，resume 发起部署的会话，消息为"部署完成：<commit>"
const work = path.join(import.meta.dirname, '../../../.work/test-magi-deploy', randomUUID());
const checkScript = path.join(work, 'check.mjs');
const failFlag = path.join(work, 'fail');
vi.setConfig({ testTimeout: 30_000 });

let magi: MagiApp;
let api: ReturnType<typeof client>['api'];
let request: ReturnType<typeof client>['request'];
let agent: Detail;

beforeAll(async () => {
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(
    checkScript,
    [
      "import fs from 'node:fs';",
      `console.log('检查的端口', process.env.WFD_PORT, process.env.WFD_WEB_PORT, '数据目录', process.env.WFD_DATA_DIR ?? '默认');`,
      `if (fs.existsSync(${JSON.stringify(failFlag)})) { console.error('检查失败：typecheck 报了 3 个错误'); process.exit(1); }`,
      "console.log('全部通过');",
    ].join('\n'),
  );
  magi = await startMagiApp(work, { WFD_MAGI_CHECK: JSON.stringify(['node', checkScript]) });
  ({ api, request } = client(magi.base));
  agent = await api<Detail>('POST', '/api/magi-agent/open', {
    engine: 'claude',
    config: 'local',
    liveId: null,
  });
  await until('Magi Agent 启动', async () =>
    (await api<Detail>('GET', `/api/live/${agent.id}`)).status === 'running' ? true : null,
  );
});

afterAll(async () => {
  await magi.close();
  fs.rmSync(work, { recursive: true, force: true });
});

const deploy = () => request('POST', '/api/magi-agent/deploy', { liveId: agent.id });
const view = () => api<MagiView>('GET', '/api/magi-agent');

async function failsWith(step: string, ...texts: string[]) {
  const response = await deploy();
  const body = (await response.json()) as { message: string };
  expect(response.status).toBe(409);
  for (const text of texts) expect(body.message).toContain(text);
  const latest = (await view()).deploy;
  expect(latest?.status).toBe('failed');
  expect(latest?.steps.find((s) => s.status === 'failed')?.id).toBe(step);
  expect(latest?.error).toBe(body.message);
  return body.message;
}

test('第 1 步：worktree 有未提交的改动时列出文件', async () => {
  fs.writeFileSync(path.join(magi.worktree, 'feature.md'), '新功能\n');
  await failsWith('clean', '未提交的改动', 'feature.md');
  await git(magi.worktree, 'add', '.');
  await git(magi.worktree, 'commit', '-q', '-m', 'agent：新功能');
});

test('第 2 步：有别的运行中的交互进程或 run 时列出它们', async () => {
  // 一个本机导入的短 session 以"本机配置"resume：替身进程
  const sessionId = randomUUID();
  const cwd = path.join(work, 'other-cwd');
  fs.mkdirSync(cwd, { recursive: true });
  const file = path.join(work, 'projects', `${sessionId}.jsonl`);
  fs.writeFileSync(file, sessionLines(sessionId, cwd));
  const { ingestFile } = await import('../../src/ingest/ingest.js');
  ingestFile(magi.db, file);
  const other = await api<Detail>('POST', '/api/live/resume', {
    sessionId,
    variantId: null,
    driver: 'human',
  });
  await failsWith('idle', `（${other.id}）有运行中的进程`);
  await api('POST', `/api/live/${other.id}/stop`);
  await until('交互进程结束', async () =>
    (await api<Detail>('GET', `/api/live/${other.id}`)).status === 'exited' ? true : null,
  );

  // 一个 running 的 run（task 由 main.ts 在启动时同步，buildApp 不同步）
  const { config } = await import('../../src/config.js');
  const { syncTasks } = await import('../../src/tasks/loader.js');
  syncTasks(magi.db, config.tasksDir);
  const variantId = randomUUID();
  magi.db
    .insert(variants)
    .values({
      id: variantId,
      name: `deploy-${variantId.slice(0, 8)}`,
      baseCommit: '0'.repeat(40),
      skillsHash: 'a'.repeat(64),
      version: '0.0.0-eval.deploy00',
      workflowId: 'lfg',
    })
    .run();
  magi.db.insert(batches).values({ id: 'b-20261014-deploy', repeats: 1 }).run();
  magi.db
    .insert(runs)
    .values({
      id: 'r-20261014-deploy',
      batchId: 'b-20261014-deploy',
      taskId: 'lfg-calculator',
      variantId,
      repeatIndex: 0,
      model: 'opus',
      effort: 'high',
      status: 'running',
      sessionId: randomUUID(),
      workspacePath: path.join(work, 'run-workspace'),
    })
    .run();
  await failsWith('idle', 'run r-20261014-deploy 的状态是 running');
  magi.db.update(runs).set({ status: 'succeeded' }).where(eq(runs.id, 'r-20261014-deploy')).run();
});

test('第 3 步：检查失败时返回输出的原文，完整输出写进日志；检查用 7398 与 5298，不继承服务的数据目录', async () => {
  fs.writeFileSync(failFlag, '');
  const message = await failsWith('check', '检查失败：typecheck 报了 3 个错误');
  expect(message).toContain('检查的端口 7398 5298 数据目录 默认');
  const latest = (await view()).deploy;
  if (latest === null) throw new Error('没有部署记录');
  const log = await request('GET', `/api/magi-agent/deploys/${String(latest.id)}/log`);
  expect(await log.text()).toContain('检查失败：typecheck 报了 3 个错误');
  fs.rmSync(failFlag);
});

test('第 4 步：合并进 main 有冲突时列出文件；主仓库有未提交的改动时停下', async () => {
  fs.writeFileSync(path.join(magi.repo, 'README.md'), 'main 上的说明\n');
  await git(magi.repo, 'commit', '-q', '-am', 'main：改说明');
  fs.writeFileSync(path.join(magi.worktree, 'README.md'), 'agent 的说明\n');
  await git(magi.worktree, 'commit', '-q', '-am', 'agent：改说明');
  await failsWith('merge-check', '有冲突', 'README.md');

  // agent 先把 main 合并进自己的分支并解决冲突
  await git(magi.worktree, 'merge', '-q', '-X', 'theirs', 'main', '-m', '合并 main');
  fs.writeFileSync(path.join(magi.repo, 'README.md'), '主仓库中没有提交的改动\n');
  await failsWith('merge-check', '未提交的改动');
  fs.writeFileSync(path.join(magi.repo, 'README.md'), 'main 上的说明\n');
});

test('六步都成功：在主仓库 merge --no-ff，备份数据库，响应之后重新启动；重新启动后 resume 发起部署的会话', async () => {
  const response = await deploy();
  const body = (await response.json()) as { status: string; commit: string };
  expect(response.status).toBe(200);
  expect(body.status).toBe('restarting');
  expect(body.commit).toBe(await git(magi.repo, 'rev-parse', 'HEAD'));
  const parents = (await git(magi.repo, 'rev-list', '--parents', '-n', '1', 'HEAD')).split(' ');
  expect(parents).toHaveLength(3);
  expect(parents[2]).toBe(await git(magi.repo, 'rev-parse', 'magi-agent'));
  expect(fs.readFileSync(path.join(magi.repo, 'feature.md'), 'utf8')).toBe('新功能\n');
  await until('响应之后调用重新启动', () => (magi.restarts.count === 1 ? true : null));
  const latest = (await view()).deploy;
  expect(latest?.steps.map((s) => s.status)).toEqual(Array(6).fill('done'));
  const backup = latest?.steps.at(-1)?.output?.replace('数据库备份在 ', '') ?? '';
  const copy = new Database(backup, { readonly: true });
  // 备份时已有前面 6 次失败的部署与这一次
  expect(copy.prepare('select count(*) as n from magi_deploys').get()).toEqual({ n: 7 });
  copy.close();

  // 服务以退出码 75 结束后由守护进程重新启动：这里关掉服务，用同一个数据库再启动一次
  await magi.close();
  await sleep(100);
  magi = await startMagiApp(work);
  ({ api, request } = client(magi.base));
  const resumed = await until('部署后 resume', async () => {
    const d = await api<Detail>('GET', `/api/live/${agent.id}`);
    return d.status === 'running' && d.processes.length === 2 ? d : null;
  });
  const deployEvent = resumed.events.find((e) => e.kind === 'deploy');
  expect(deployEvent?.payload).toMatchObject({ commit: body.commit });
  const argv = resumed.events.findLast((e) => e.kind === 'start' || e.kind === 'resume')?.payload
    .argv as string[];
  expect(argv.at(-1)).toBe(`部署完成：${body.commit}`);
  expect((await view()).deploy?.status).toBe('done');
  await api('POST', `/api/live/${agent.id}/stop`);
});
