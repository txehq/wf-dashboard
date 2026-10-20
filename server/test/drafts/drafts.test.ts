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
// 保存的各种校验失败（以原文失败，草稿保留，不建 workflow 与 variant）、保存成功（不构建，名字与描述必填）、
// Codex 会话的结束、resume 与删除。
// Codex 用测试中的替身命令，只验证页面与 API；skill 的来源是 .work/ 下的本地 git 仓库（不依赖网络），
// 把其中一个仓库暂时移走就是可控的失败。
// 新建与覆盖两条路径、历史与恢复在 drafts-save-target.test.ts；lfg 之下保存后用 wf 真实构建在慢档 drafts-save.test.ts。
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
  savedVariants: { id: string; name: string }[];
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

// 第一次保存为新 workflow 的请求：workflow 与第一个 variant 的名字与描述
const firstSave = {
  target: { kind: 'new', name: '初稿', description: '第一版' },
  workflow: { name: '你好流程', description: '打招呼' },
};
const newVariant = (name: string) => ({ target: { kind: 'new', name, description: name } });

async function save(id: string, payload: Record<string, unknown> = firstSave) {
  return app.inject({ method: 'POST', url: `/api/workflow-drafts/${id}/save`, payload });
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
      engine: 'codex',
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
    expect((await save(draft.id, newVariant('未准备好'))).statusCode).toBe(409);
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

  test('mode workflow：从空白骨架开始的草稿目录、装好的 skill、Live 中的 Codex 会话', async () => {
    const { draft, live } = await createDraft({
      mode: 'workflow',
      engine: 'codex',
      workflowId: newId,
      name: `你好 ${marker}`,
      description: '打招呼',
      requirement: '做一个打招呼的 workflow',
    });
    workflowDraft = draft;
    workflowLive = live;
    expect(draft.id).toMatch(/^d-\d{8}-[a-z0-9]{6}$/);
    expect(draft.dir).toBe(path.join(config.workflowDraftsDir, draft.id));
    // src/ 只有入口与一个小阶段的 SKILL.md 骨架（Contracts 18.5），没有 txe-workflow 的导出
    expect(fs.readdirSync(path.join(draft.dir, 'src'))).toEqual(['skills']);
    expect(fs.readdirSync(path.join(draft.dir, 'src/skills')).sort()).toEqual(
      [newId, 'stage-1'].sort(),
    );
    expect(fs.readFileSync(path.join(draft.dir, 'src/skills/stage-1/SKILL.md'), 'utf8')).toBe(
      `---\nname: stage-1\ndescription: 你好 ${marker} 的小阶段 stage-1\n---\n\n在这里写这个阶段做什么。\n`,
    );
    expect(parseYaml(fs.readFileSync(path.join(draft.dir, 'workflow.yaml'), 'utf8'))).toEqual({
      id: newId,
      name: `你好 ${marker}`,
      stages: [{ id: 'stage-1' }],
    });
    // 说明是自有管理器的那一份：没有 wf，没有两份清单
    const platform = fs.readFileSync(path.join(draft.dir, 'PLATFORM.md'), 'utf8');
    expect(platform).toContain('这个 workflow 不用 wf');
    expect(platform).not.toContain('wf release build-local');
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
    expect(live.title).toBe(newId);
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
      engine: 'codex',
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
    expect(live.title).toBe(`lfg · 草稿底子 ${marker}`);
    // 缺阶段 skill：底子只有 lfg 一个 skill
    const missing = await save(draft.id, newVariant('缺阶段'));
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
        engine: 'codex',
        workflowId: 'ic',
        name: 'x',
        description: '',
        requirement: 'x',
      },
    });
    expect(used.statusCode).toBe(400);
    expect(used.body).toContain('workflow id ic 已被使用');
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/workflow-drafts',
      payload: {
        mode: 'variant',
        engine: 'codex',
        workflowId: 'ic',
        requirement: 'x',
        baseVariantId: base.id,
      },
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
    // 缺入口 skill（先去掉骨架）
    for (const name of [newId, 'stage-1']) fs.rmSync(path.join(skills, name), { recursive: true });
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

  test('保存成功：不构建，建 workflow 与它的第一个 variant（名字与描述必填），再次保存新建或同名 409', async () => {
    const skills = path.join(workflowDraft.dir, 'src/skills');
    fs.writeFileSync(path.join(skills, 'review', 'SKILL.md'), skillMd('review'));
    // 保存前的改动预览（Contracts 21.3）：从空白开始的草稿没有底子，src/skills 中的文件都是新增
    const preview = await app.inject({
      method: 'GET',
      url: `/api/workflow-drafts/${workflowDraft.id}/diff`,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const diff = preview.json<{
      base: unknown;
      files: { path: string; status: string; oldContent: string; patch: string }[];
    }>();
    expect(diff.base).toBeNull();
    expect(diff.files.map((f) => f.path)).toEqual(
      fs
        .readdirSync(skills)
        .sort()
        .map((name) => `skills/${name}/SKILL.md`),
    );
    expect(diff.files.every((f) => f.status === 'added' && f.oldContent === '')).toBe(true);
    expect(diff.files.find((f) => f.path === 'skills/review/SKILL.md')?.patch).toContain(
      '--- /dev/null\n+++ b/skills/review/SKILL.md\n',
    );
    // 第一次保存为新 workflow：workflow 与第一个 variant 的名字与描述都必填；新 workflow 下只能新建
    const plan = await app.inject({
      method: 'GET',
      url: `/api/workflow-drafts/${workflowDraft.id}/save-plan`,
    });
    expect(plan.json()).toEqual({
      kind: 'new-workflow',
      workflowId: newId,
      workflowName: '你好',
      workflowDescription: '打招呼',
      variantName: '初稿',
    });
    for (const [payload, error] of [
      [
        { target: firstSave.target },
        `第一次保存为新 workflow ${newId}，要填 workflow 的名字与描述`,
      ],
      [{ ...firstSave, workflow: { name: '你好', description: ' ' } }, 'workflow 的描述不能为空'],
      [{ ...firstSave, target: { ...firstSave.target, name: '' } }, 'variant 的名字不能为空'],
      [
        {
          ...firstSave,
          target: { kind: 'overwrite', variantId: base.id, name: 'x', description: 'x' },
        },
        `新 workflow ${newId} 还没有 variant，只能新建第一个 variant`,
      ],
    ] as const) {
      const rejected = await save(workflowDraft.id, payload);
      expect(rejected.statusCode).toBe(400);
      expect(rejected.body).toContain(error);
      await expectUnsaved(workflowDraft, newId);
    }
    const response = await save(workflowDraft.id);
    expect(response.statusCode, response.body).toBe(200);
    const saved = response.json<Draft>();
    expect(saved.savedWorkflowId).toBe(newId);
    const workflow = (await app.inject({ method: 'GET', url: `/api/workflows/${newId}` })).json<{
      name: string;
      evalKind: string | null;
      description: string | null;
    }>();
    expect([workflow.name, workflow.evalKind, workflow.description]).toEqual([
      '你好流程',
      null,
      '打招呼',
    ]);
    expect(saved.savedVariants.map((v) => v.name)).toEqual(['初稿']);
    const first = (
      await app.inject({ method: 'GET', url: `/api/variants/${saved.savedVariants[0]?.id ?? ''}` })
    ).json<{
      id: string;
      parentId: string | null;
      baseCommit: string;
      description: string;
      status: string;
      buildStatus: string;
      builtHash: string | null;
      draftId: string;
      installDir: string;
    }>();
    // 保存不构建：状态为 draft、未构建，没有构建产物
    expect(first).toMatchObject({
      parentId: null,
      baseCommit: '',
      description: '第一版',
      status: 'draft',
      buildStatus: 'none',
      builtHash: null,
      draftId: workflowDraft.id,
    });
    expect(fs.existsSync(path.join(first.installDir, 'home/claude/skills'))).toBe(false);
    expect(fs.existsSync(path.join(first.installDir, 'variant.json'))).toBe(false);
    const log = (await app.inject({ method: 'GET', url: `/api/variants/${first.id}/build-log` }))
      .body;
    expect(log).toContain(`从 Codex 草稿 ${workflowDraft.id} 保存（没有底子），需要构建`);
    expect(log).not.toContain('=== 构建');

    // 再次保存：保存到已保存出的 workflow，新建或覆盖；同名 409
    const againPlan = (
      await app.inject({ method: 'GET', url: `/api/workflow-drafts/${workflowDraft.id}/save-plan` })
    ).json<{ kind: string; variants: { name: string; reason: string | null }[] }>();
    expect(againPlan.kind).toBe('variant');
    expect(againPlan.variants).toEqual([
      { id: first.id, name: '初稿', description: '第一版', reason: null },
    ]);
    const taken = await save(workflowDraft.id, newVariant('初稿'));
    expect(taken.statusCode).toBe(409);
    expect(taken.body).toContain(`名称已被使用：初稿 (${newId})`);
    const again = await save(workflowDraft.id, newVariant('第二稿'));
    expect(again.statusCode, again.body).toBe(200);
    expect(
      again.json<{ savedVariants: { name: string }[] }>().savedVariants.map((v) => v.name),
    ).toEqual(['初稿', '第二稿']);
    // workflow.yaml 改了小阶段：以原文失败，不建 variant
    fs.appendFileSync(path.join(workflowDraft.dir, 'workflow.yaml'), '  - id: publish\n');
    const changed = await save(workflowDraft.id, newVariant('第三稿'));
    expect(changed.statusCode).toBe(400);
    expect(changed.body).toContain(`workflow.yaml 与已保存的 workflow ${newId} 的定义不同`);
  });

  test('结束 Codex 进程、resume 接着同一个会话、删除交互项不删除草稿', async () => {
    const stopped = await app.inject({ method: 'POST', url: `/api/live/${workflowLive.id}/stop` });
    expect(stopped.json<Live>().status).toBe('exited');
    const resumed = await app.inject({
      method: 'POST',
      url: `/api/live/${workflowLive.id}/draft-resume`,
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
      url: `/api/live/${workflowLive.id}/draft-resume`,
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
