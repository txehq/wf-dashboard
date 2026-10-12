import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from '@decimalturn/toml-patch';
import { execaSync } from 'execa';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { codexStandIn, makeSkillSources } from '../helpers/codex-skills.js';

// 基础档（Contracts 第 17 节）：发起立即返回、后台准备（preparing → open，某一步失败 → failed → 从那一步重试）、
// 草稿目录的生成（mode workflow 与 variant）、装 skill 与 Codex 会话、
// 保存的各种校验失败（以原文失败，草稿保留，不建 workflow 与 variant）、Codex 会话的结束、resume 与删除。
// Codex 用测试中的替身命令，只验证页面与 API；skill 的来源是 .work/ 下的本地 git 仓库（不依赖网络），
// 把其中一个仓库暂时移走就是可控的失败。
// 成功保存要真实构建，在慢档 drafts-save.test.ts。
// 被导出的 workflow 仓库：只有 skills/lfg/SKILL.md 与 Cargo.toml 的最小本地 git 仓库（与 variants-api 相同）
const work = path.resolve(import.meta.dirname, '../../../.work/test-drafts', randomUUID());
const repo = path.join(work, 'txe-workflow');
fs.mkdirSync(path.join(repo, 'skills/lfg'), { recursive: true });
fs.writeFileSync(
  path.join(repo, 'skills/lfg/SKILL.md'),
  '---\nname: lfg\ndescription: lfg 入口\n---\n\n# lfg\n',
);
fs.writeFileSync(path.join(repo, 'Cargo.toml'), '[workspace.package]\nversion = "0.1.0"\n');
const identity = ['-c', 'user.name=wf-dashboard', '-c', 'user.email=wf@example.invalid'];
const git = (...args: string[]) => execaSync('git', ['-C', repo, ...identity, ...args]);
git('init', '--quiet', '--initial-branch', 'main');
git('add', '.');
git('commit', '--quiet', '-m', 'skills');
process.env.WFD_TXE_WORKFLOW = repo;
const sources = makeSkillSources(path.join(work, 'skill-sources'));
process.env.WFD_CODEX_SKILL_SOURCES = JSON.stringify(sources);
process.env.WFD_CODEX_BIN = codexStandIn;

const { buildApp } = await import('../../src/api/app.js');
const { config } = await import('../../src/config.js');
const { openDatabase } = await import('../../src/db/index.js');

const dbFile = path.join(config.repoRoot, '.work', 'test-db', `${randomUUID()}.sqlite`);
const db = openDatabase(dbFile, config.migrationsDir);
const app = await buildApp({
  db,
  sseHeartbeatMs: config.sseHeartbeatMs,
  logger: false,
  tasksDir: config.tasksDir,
});
const marker = randomUUID().slice(0, 6);

interface Draft {
  id: string;
  mode: string;
  workflowId: string;
  liveId: string | null;
  status: string;
  error: string | null;
  steps: { id: string; status: string; error: string | null }[];
  savedWorkflowId: string | null;
  savedVariants: unknown[];
  skills: { name: string; source: string; computedHash: string; commit: string }[];
  dir: string;
}
interface Live {
  id: string;
  engine: string;
  draftId: string | null;
  claudeSessionId: string | null;
  status: string;
  cwd: string;
  title: string;
  process: { kind: string } | null;
  processes: { kind: string; status: string; variantId: string | null }[];
  events: { kind: string; payload: Record<string, unknown> }[];
}

let base: { id: string };

beforeAll(async () => {
  await app.ready();
  const created = await app.inject({
    method: 'POST',
    url: '/api/variants',
    payload: { name: `草稿底子 ${marker}` },
  });
  expect(created.statusCode).toBe(201);
  base = created.json<{ id: string }>();
});

afterAll(async () => {
  await app.close();
  db.$client.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const getDraft = async (id: string) =>
  (await app.inject({ method: 'GET', url: `/api/workflow-drafts/${id}` })).json<Draft>();
const getLive = async (id: string) =>
  (await app.inject({ method: 'GET', url: `/api/live/${id}` })).json<Live>();

// 后台准备结束：全部步骤完成（Codex 已启动）或某一步失败
async function settled(id: string): Promise<Draft> {
  for (;;) {
    const d = await getDraft(id);
    if (d.status === 'failed' || d.steps.every((s) => s.status === 'done')) return d;
    await sleep(100);
  }
}

// 发起：请求在 1 秒内返回，草稿为 preparing、交互项还没有进程；不等准备
async function startDraft(payload: Record<string, unknown>) {
  const started = performance.now();
  const response = await app.inject({ method: 'POST', url: '/api/workflow-drafts', payload });
  const elapsed = performance.now() - started;
  expect(response.statusCode, response.body).toBe(201);
  expect(elapsed).toBeLessThan(1000);
  const body = response.json<{ draft: Draft; live: Live }>();
  expect(body.draft.status).toBe('preparing');
  expect(body.live.status).toBe('idle');
  expect(body.live.claudeSessionId).toBeNull();
  return body;
}

// 发起并等准备完成
async function createDraft(payload: Record<string, unknown>) {
  const { draft } = await startDraft(payload);
  const ready = await settled(draft.id);
  expect(ready.status, ready.error ?? '').toBe('open');
  return { draft: ready, live: await getLive(ready.liveId ?? '') };
}

async function save(id: string) {
  return app.inject({ method: 'POST', url: `/api/workflow-drafts/${id}/save` });
}

const skillMd = (name: string) =>
  `---\nname: ${name}\ndescription: ${name} 阶段\n---\n\n# ${name}\n`;

// 保存失败后：草稿仍是 open、没有保存出 variant、目录还在，workflow 没有建出
async function expectUnsaved(draft: Draft, workflowId: string) {
  const after = (
    await app.inject({ method: 'GET', url: `/api/workflow-drafts/${draft.id}` })
  ).json<Draft>();
  expect(after.status).toBe('open');
  expect(after.savedVariants).toEqual([]);
  expect(fs.existsSync(path.join(draft.dir, 'workflow.yaml'))).toBe(true);
  expect(
    (await app.inject({ method: 'GET', url: `/api/workflows/${workflowId}` })).statusCode,
  ).toBe(404);
}

describe('用 Codex 生成 workflow 或 variant（基础档）', { timeout: 60_000 }, () => {
  let workflowDraft: Draft;
  let workflowLive: Live;
  const newId = `hello-${marker}`;

  test('准备在后台进行：某一步失败时 failed 并显示原文，重试从失败的那一步接着做，完成后 open 并启动 Codex', async () => {
    // 第三个 skill 的来源暂时不存在
    const last = sources.at(-1);
    if (last === undefined) throw new Error('没有 skill 来源');
    const away = `${last.source}.away`;
    fs.renameSync(last.source, away);
    const { draft, live } = await startDraft({
      mode: 'variant',
      workflowId: 'lfg',
      requirement: '重试的测试',
      baseVariantId: base.id,
    });
    expect(draft.steps.map((s) => s.id)).toEqual([
      'copy-src',
      'write-docs',
      ...sources.map((s) => `skill:${s.name}`),
      'start-codex',
    ]);
    expect(draft.liveId).toBe(live.id);
    expect(live.draftId).toBe(draft.id);
    const failed = await settled(draft.id);
    expect(failed.status).toBe('failed');
    const step = failed.steps.find((s) => s.id === `skill:${last.name}`);
    expect(step?.status).toBe('failed');
    expect(step?.error).toContain(`git ls-remote ${last.source} HEAD`);
    expect(failed.error).toContain(`安装 ${last.name}失败`);
    expect(failed.steps.filter((s) => s.status === 'done').map((s) => s.id)).toEqual([
      'copy-src',
      'write-docs',
      ...sources.slice(0, -1).map((s) => `skill:${s.name}`),
    ]);
    expect((await getLive(live.id)).process).toBeNull();
    // 准备没完成时不能保存
    expect((await save(draft.id)).statusCode).toBe(409);
    // 前面的步骤不再重做：记下已装 skill 的文件时间
    const firstSkill = path.join(draft.dir, '.agents/skills', sources[0]?.name ?? '', 'SKILL.md');
    const mtime = fs.statSync(firstSkill).mtimeMs;

    fs.renameSync(away, last.source);
    const retried = await app.inject({
      method: 'POST',
      url: `/api/workflow-drafts/${draft.id}/retry`,
    });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json<Draft>().status).toBe('preparing');
    const again = await app.inject({
      method: 'POST',
      url: `/api/workflow-drafts/${draft.id}/retry`,
    });
    expect(again.statusCode).toBe(409);
    const ready = await settled(draft.id);
    expect(ready.status, ready.error ?? '').toBe('open');
    expect(ready.error).toBeNull();
    expect(ready.steps.every((s) => s.status === 'done' && s.error === null)).toBe(true);
    expect(ready.skills.map((s) => s.name).sort()).toEqual(sources.map((s) => s.name).sort());
    expect(fs.statSync(firstSkill).mtimeMs).toBe(mtime);
    const started = await getLive(live.id);
    expect(started.status).toBe('running');
    expect(started.claudeSessionId).not.toBeNull();
    expect(started.processes.map((p) => p.kind)).toEqual(['start']);
    await app.inject({ method: 'POST', url: `/api/live/${live.id}/stop` });
  });

  test('mode workflow：草稿目录、装好的 skill、Live 中的 Codex 会话', async () => {
    const { draft, live } = await createDraft({
      mode: 'workflow',
      workflowId: newId,
      name: `你好 ${marker}`,
      requirement: '做一个打招呼的 workflow',
      baseVariantId: base.id,
    });
    workflowDraft = draft;
    workflowLive = live;
    expect(draft.id).toMatch(/^d-\d{8}-[a-z0-9]{6}$/);
    expect(draft.dir).toBe(path.join(config.workflowDraftsDir, draft.id));
    // src/ 是底子 variant 的 src 副本
    expect(fs.readFileSync(path.join(draft.dir, 'src/skills/lfg/SKILL.md'), 'utf8')).toBe(
      fs.readFileSync(path.join(repo, 'skills/lfg/SKILL.md'), 'utf8'),
    );
    expect(fs.existsSync(path.join(draft.dir, 'src/Cargo.toml'))).toBe(true);
    // workflow.yaml 先填 id、名字与底子的小阶段
    expect(parseYaml(fs.readFileSync(path.join(draft.dir, 'workflow.yaml'), 'utf8'))).toEqual({
      id: newId,
      name: `你好 ${marker}`,
      stages: [{ id: 'interview' }, { id: 'research' }, { id: 'plan' }, { id: 'ticketing' }],
    });
    expect(fs.readFileSync(path.join(draft.dir, 'PLATFORM.md'), 'utf8')).toContain(
      'wf release build-local',
    );
    const example = path.join(draft.dir, 'examples/simple-workflow');
    expect(parseYaml(fs.readFileSync(path.join(example, 'workflow.yaml'), 'utf8'))).toEqual({
      id: 'hello-flow',
      name: '你好流程',
      stages: [{ id: 'gather' }, { id: 'draft' }, { id: 'review', repeatable: true }],
    });
    for (const name of ['hello-flow', 'gather', 'draft', 'review']) {
      expect(fs.existsSync(path.join(example, 'skills', name, 'SKILL.md'))).toBe(true);
    }
    // 三个 skill 以项目范围装进 .agents/skills/，版本记进草稿
    expect(draft.skills.map((s) => s.name).sort()).toEqual([
      'find-skills',
      'skill-creator',
      'writing-for-agents',
    ]);
    for (const skill of draft.skills) {
      const source = sources.find((s) => s.name === skill.name);
      expect(skill.source).toBe(source?.source);
      expect(skill.commit).toBe(
        execaSync('git', ['-C', skill.source, 'rev-parse', 'HEAD']).stdout.trim(),
      );
      expect(skill.computedHash).toMatch(/^[0-9a-f]{64}$/);
      expect(
        fs.readFileSync(path.join(draft.dir, '.agents/skills', skill.name, 'SKILL.md'), 'utf8'),
      ).toBe(fs.readFileSync(path.join(skill.source, 'skills', skill.name, 'SKILL.md'), 'utf8'));
    }
    expect(fs.existsSync(path.join(draft.dir, 'home/.agents'))).toBe(false);
    // Codex 会话：engine codex，cwd 为草稿目录，会话 id 取自替身写出的 rollout
    expect(live.engine).toBe('codex');
    expect(live.draftId).toBe(draft.id);
    expect(draft.liveId).toBe(live.id);
    expect(live.cwd).toBe(draft.dir);
    expect(live.status).toBe('running');
    expect(live.title).toBe(`Codex：新 workflow ${newId}`.slice(0, 40));
    const start = live.events.find((e) => e.kind === 'start');
    expect(start?.payload.argv).toEqual([
      codexStandIn,
      '--no-daemon',
      '-s',
      'workspace-write',
      '-c',
      'sandbox_workspace_write.network_access=true',
      expect.stringContaining('做一个打招呼的 workflow'),
    ]);
    expect(start?.payload.home).toBe(path.join(draft.dir, 'home'));
    const rollouts = fs.readdirSync(path.join(draft.dir, 'codex-home/sessions'), {
      recursive: true,
    });
    const sessionId = live.claudeSessionId ?? '';
    expect(sessionId).not.toBe('');
    expect(rollouts.some((f) => String(f).endsWith(`-${sessionId}.jsonl`))).toBe(true);
    // CODEX_HOME 的配置：草稿目录已信任、不检查更新、关掉 bundled skill
    const toml: unknown = parseToml(
      fs.readFileSync(path.join(draft.dir, 'codex-home/config.toml'), 'utf8'),
    );
    expect(toml).toMatchObject({
      check_for_update_on_startup: false,
      projects: { [draft.dir]: { trust_level: 'trusted' } },
      skills: { bundled: { enabled: false } },
    });
    expect(fs.existsSync(path.join(draft.dir, 'codex-home/auth.json'))).toBe(true);
    // 只有人驾驶：hook 与驾驶者切换 409
    const driver = await app.inject({
      method: 'POST',
      url: `/api/live/${live.id}/driver`,
      payload: { driver: 'simulated' },
    });
    expect(driver.statusCode).toBe(409);
    expect(driver.body).toContain('只有人驾驶');
  });

  test('mode variant：workflow.yaml 是所属 workflow 定义的只读副本', async () => {
    const { draft, live } = await createDraft({
      mode: 'variant',
      workflowId: 'lfg',
      requirement: '把 interview 改得更短',
      baseVariantId: base.id,
    });
    const file = path.join(draft.dir, 'workflow.yaml');
    expect(parseYaml(fs.readFileSync(file, 'utf8'))).toEqual({
      id: 'lfg',
      name: 'lfg',
      stages: [{ id: 'interview' }, { id: 'research' }, { id: 'plan' }, { id: 'ticketing' }],
    });
    expect(fs.statSync(file).mode & 0o777).toBe(0o444);
    expect(live.title).toBe('Codex：lfg 的新 variant');
    // 缺阶段 skill：底子只有 lfg 一个 skill
    const missing = await save(draft.id);
    expect(missing.statusCode).toBe(400);
    expect(missing.body).toContain(
      '缺少 workflow lfg 要求的 skill：interview、research、plan、ticketing',
    );
    const after = (
      await app.inject({ method: 'GET', url: `/api/workflow-drafts/${draft.id}` })
    ).json<Draft>();
    expect(after.savedVariants).toEqual([]);
    await app.inject({ method: 'POST', url: `/api/live/${live.id}/stop` });
  });

  test('发起时的校验：id 已被使用、底子 variant 不属于这个 workflow', async () => {
    const used = await app.inject({
      method: 'POST',
      url: '/api/workflow-drafts',
      payload: {
        mode: 'workflow',
        workflowId: 'ic',
        name: 'x',
        requirement: 'x',
        baseVariantId: base.id,
      },
    });
    expect(used.statusCode).toBe(400);
    expect(used.body).toContain('workflow id ic 已被使用');
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/workflow-drafts',
      payload: { mode: 'variant', workflowId: 'ic', requirement: 'x', baseVariantId: base.id },
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.body).toContain('不是 ic 的 variant');
  });

  test('保存的校验：workflow.yaml 不合法、缺入口 skill、缺阶段 skill、frontmatter 不合法，各以原文失败', async () => {
    const dir = workflowDraft.dir;
    const yamlFile = path.join(dir, 'workflow.yaml');
    const skills = path.join(dir, 'src/skills');

    fs.writeFileSync(yamlFile, 'id: [a\n');
    let response = await save(workflowDraft.id);
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('workflow.yaml 不是合法的 YAML');
    await expectUnsaved(workflowDraft, newId);

    fs.writeFileSync(
      yamlFile,
      `id: ${newId}\nname: 你好\nstages:\n  - id: gather\n  - id: gather\n`,
    );
    response = await save(workflowDraft.id);
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('workflow.yaml 不符合 workflow schema');
    expect(response.body).toContain('小阶段 id 重复：gather');
    await expectUnsaved(workflowDraft, newId);

    fs.writeFileSync(
      yamlFile,
      `id: ${newId}\nname: 你好\nstages:\n  - id: gather\n  - id: draft\n  - id: review\n    repeatable: true\n`,
    );
    // 缺入口 skill
    for (const name of ['gather', 'draft', 'review']) {
      fs.mkdirSync(path.join(skills, name), { recursive: true });
      fs.writeFileSync(path.join(skills, name, 'SKILL.md'), skillMd(name));
    }
    response = await save(workflowDraft.id);
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain(`缺少 workflow ${newId} 要求的 skill：${newId}（`);
    await expectUnsaved(workflowDraft, newId);

    // 缺阶段 skill
    fs.mkdirSync(path.join(skills, newId), { recursive: true });
    fs.writeFileSync(path.join(skills, newId, 'SKILL.md'), skillMd(newId));
    fs.rmSync(path.join(skills, 'review'), { recursive: true });
    response = await save(workflowDraft.id);
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain(`缺少 workflow ${newId} 要求的 skill：review（`);
    await expectUnsaved(workflowDraft, newId);

    fs.mkdirSync(path.join(skills, 'review'), { recursive: true });
    fs.writeFileSync(path.join(skills, 'review', 'SKILL.md'), '---\nname: [review\n---\n');
    response = await save(workflowDraft.id);
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('review/SKILL.md 的 frontmatter 不是合法的 YAML');
    await expectUnsaved(workflowDraft, newId);

    fs.writeFileSync(
      path.join(skills, 'review', 'SKILL.md'),
      '---\nname: reviewer\ndescription: x\n---\n',
    );
    response = await save(workflowDraft.id);
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('frontmatter name 为 reviewer，应与目录名 review 相同');

    fs.writeFileSync(path.join(skills, 'review', 'SKILL.md'), '# review\n没有 frontmatter\n');
    response = await save(workflowDraft.id);
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('review/SKILL.md 没有 YAML frontmatter');
    await expectUnsaved(workflowDraft, newId);
  });

  test('结束 Codex 进程、resume 接着同一个会话、删除交互项不删除草稿', async () => {
    const stopped = await app.inject({ method: 'POST', url: `/api/live/${workflowLive.id}/stop` });
    expect(stopped.json<Live>().status).toBe('exited');
    const resumed = await app.inject({
      method: 'POST',
      url: `/api/live/${workflowLive.id}/codex-resume`,
    });
    expect(resumed.statusCode, resumed.body).toBe(201);
    const live = resumed.json<Live>();
    expect(live.id).toBe(workflowLive.id);
    expect(live.claudeSessionId).toBe(workflowLive.claudeSessionId);
    expect(live.processes.map((p) => p.kind)).toEqual(['start', 'resume']);
    expect(live.events.find((e) => e.kind === 'resume')?.payload.argv).toEqual([
      codexStandIn,
      'resume',
      '--no-daemon',
      '-s',
      'workspace-write',
      '-c',
      'sandbox_workspace_write.network_access=true',
      workflowLive.claudeSessionId,
    ]);
    const again = await app.inject({
      method: 'POST',
      url: `/api/live/${workflowLive.id}/codex-resume`,
    });
    expect(again.statusCode).toBe(409);
    await app.inject({ method: 'POST', url: `/api/live/${workflowLive.id}/stop` });

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/live/${workflowLive.id}`,
      payload: { confirmTitle: workflowLive.title },
    });
    expect(removed.statusCode).toBe(200);
    const draft = (
      await app.inject({ method: 'GET', url: `/api/workflow-drafts/${workflowDraft.id}` })
    ).json<Draft>();
    expect(draft.liveId).toBeNull();
    expect(fs.existsSync(path.join(draft.dir, 'src/skills'))).toBe(true);
  });
});
