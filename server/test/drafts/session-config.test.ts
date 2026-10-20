import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from '@decimalturn/toml-patch';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { writeClaudeStandIn } from '../helpers/claude-stand-in.js';
import { codexStandIn, makeSkillSources } from '../helpers/codex-skills.js';

// 基础档（Contracts 28.1、28.2、28.4）：设计会话的 platform-mcp；src/mcp.json 同步进 Claude Code 与 Codex 两种
// 会话配置（下一次启动或 resume 生效）与构建出的 variant 的 --mcp-config；src/skills 随写随装进会话配置、删除同步，
// 工具 skill 与 platform-mcp 不受影响；保存来源与构建日志、覆盖的历史按草稿的引擎写。Claude Code 与 Codex 都是
// 测试自己的替身，目录都建在 .work/ 下
const work = path.resolve(import.meta.dirname, '../../../.work/test-drafts', randomUUID());
const sources = makeSkillSources(path.join(work, 'skill-sources'));
process.env.WFD_CODEX_SKILL_SOURCES = JSON.stringify(sources);
process.env.WFD_CODEX_BIN = codexStandIn;
process.env.WFD_CLAUDE_BIN = writeClaudeStandIn(path.join(work, 'bin'));

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
const toolSkills = sources.map((s) => s.name).sort();

interface Draft {
  id: string;
  status: string;
  error: string | null;
  liveId: string;
  dir: string;
  steps: { id: string; label: string; status: string }[];
  savedVariantId: string | null;
}
interface Live {
  id: string;
  status: string;
}
interface Variant {
  id: string;
  draftId: string | null;
  skillsHash: string;
  buildStatus: string;
  buildError: string | null;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));
const dirs = (dir: string) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

// 条件在 timeoutMs 内成立；返回用了多少毫秒
async function within(timeoutMs: number, check: () => boolean): Promise<number> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`${String(timeoutMs)} ms 内条件没有成立`);
    await sleep(25);
  }
  return Date.now() - started;
}

async function openDraft(engine: 'claude' | 'codex', workflowId: string): Promise<Draft> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/workflow-drafts',
    payload: {
      mode: 'workflow',
      engine,
      workflowId,
      name: `会话配置 ${engine}`,
      description: '打招呼',
      requirement: '做一个打招呼的 workflow',
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json<{ draft: Draft }>().draft.id;
  for (;;) {
    const draft = (
      await app.inject({ method: 'GET', url: `/api/workflow-drafts/${id}` })
    ).json<Draft>();
    if (draft.status === 'failed') throw new Error(draft.error ?? '准备失败');
    if (draft.steps.every((s) => s.status === 'done')) return draft;
    await sleep(100);
  }
}

async function restart(liveId: string): Promise<Live> {
  const stopped = await app.inject({ method: 'POST', url: `/api/live/${liveId}/stop` });
  expect(stopped.json<Live>().status).toBe('exited');
  const resumed = await app.inject({ method: 'POST', url: `/api/live/${liveId}/draft-resume` });
  expect(resumed.statusCode, resumed.body).toBe(201);
  return resumed.json<Live>();
}

function writeSkill(src: string, name: string, body: string) {
  fs.mkdirSync(path.join(src, 'skills', name), { recursive: true });
  fs.writeFileSync(
    path.join(src, 'skills', name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} 的说明\n---\n\n${body}\n`,
  );
}

const mcpFile = {
  mcpServers: {
    linear: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-remote', 'https://mcp.linear.app/mcp'],
      env: { WF_MCP_COMPONENT: 'test' },
    },
    docs: { type: 'http', url: 'https://example.invalid/mcp', headers: { 'X-Test': '1' } },
  },
};

beforeAll(async () => {
  await app.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await app.close();
  db.$client.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

describe('设计会话的 MCP 与试跑（基础档，替身）', { timeout: 60_000 }, () => {
  const claudeWorkflow = `cfg-claude-${marker}`;
  let claudeDraft: Draft;

  test('Claude Code：platform-mcp 与三个工具 skill 在 .claude/skills/；启动前 src/skills 已装进 claude-config/skills/', async () => {
    claudeDraft = await openDraft('claude', claudeWorkflow);
    expect(claudeDraft.steps.find((s) => s.id === 'write-docs')?.label).toContain('platform-mcp');
    expect(dirs(path.join(claudeDraft.dir, '.claude/skills'))).toEqual(
      [...toolSkills, 'platform-mcp'].sort(),
    );
    const skill = fs.readFileSync(
      path.join(claudeDraft.dir, '.claude/skills/platform-mcp/SKILL.md'),
      'utf8',
    );
    expect(skill).toMatch(/^---\nname: platform-mcp\n/);
    expect(skill).toContain('src/mcp.json');
    expect(dirs(path.join(claudeDraft.dir, 'claude-config/skills'))).toEqual(
      [claudeWorkflow, 'stage-1'].sort(),
    );
  });

  test('Claude Code：src/skills 中新增、修改、删除 1 秒内同步进 claude-config/skills/；与工具 skill 同名的不装', async () => {
    const src = path.join(claudeDraft.dir, 'src');
    const installed = path.join(claudeDraft.dir, 'claude-config/skills');
    writeSkill(src, 'extra', '第一版');
    const added = await within(1000, () => fs.existsSync(path.join(installed, 'extra/SKILL.md')));
    expect(added).toBeLessThan(1000);
    fs.mkdirSync(path.join(src, 'skills/extra/references'));
    fs.writeFileSync(path.join(src, 'skills/extra/references/notes.md'), '笔记\n');
    writeSkill(src, 'extra', '第二版');
    await within(1000, () =>
      fs.readFileSync(path.join(installed, 'extra/SKILL.md'), 'utf8').includes('第二版'),
    );
    await within(1000, () => fs.existsSync(path.join(installed, 'extra/references/notes.md')));
    // 与工具 skill 同名：不装进会话配置，.claude/skills/ 中的工具 skill 原样
    const tool = toolSkills[0] ?? '';
    const toolFile = path.join(claudeDraft.dir, '.claude/skills', tool, 'SKILL.md');
    const toolBefore = fs.readFileSync(toolFile, 'utf8');
    writeSkill(src, tool, '同名');
    fs.rmSync(path.join(src, 'skills/extra'), { recursive: true });
    await within(1000, () => !fs.existsSync(path.join(installed, 'extra')));
    expect(dirs(installed)).toEqual([claudeWorkflow, 'stage-1'].sort());
    expect(fs.readFileSync(toolFile, 'utf8')).toBe(toolBefore);
    fs.rmSync(path.join(src, 'skills', tool), { recursive: true });
    expect(dirs(path.join(claudeDraft.dir, '.claude/skills'))).toEqual(
      [...toolSkills, 'platform-mcp'].sort(),
    );
  });

  test('Claude Code：src/mcp.json 在 resume 时写进 claude-config/.claude.json 的 mcpServers，删除后清空', async () => {
    const src = path.join(claudeDraft.dir, 'src');
    const state = path.join(claudeDraft.dir, 'claude-config/.claude.json');
    fs.writeFileSync(path.join(src, 'mcp.json'), JSON.stringify(mcpFile));
    // 进程运行中不改配置：下一次启动或 resume 生效
    await sleep(300);
    expect(readJson(state)).not.toHaveProperty('mcpServers.linear');
    await restart(claudeDraft.liveId);
    expect(readJson(state)).toMatchObject({
      hasCompletedOnboarding: true,
      projects: { [claudeDraft.dir]: { hasTrustDialogAccepted: true } },
      mcpServers: mcpFile.mcpServers,
    });
    fs.rmSync(path.join(src, 'mcp.json'));
    await restart(claudeDraft.liveId);
    expect(readJson(state)).toMatchObject({ mcpServers: {} });
    // 格式不对时 resume 以原文失败
    fs.writeFileSync(
      path.join(src, 'mcp.json'),
      JSON.stringify({ mcpServers: { bad: { args: [] } } }),
    );
    await app.inject({ method: 'POST', url: `/api/live/${claudeDraft.liveId}/stop` });
    const failed = await app.inject({
      method: 'POST',
      url: `/api/live/${claudeDraft.liveId}/draft-resume`,
    });
    expect(failed.statusCode).toBe(400);
    expect(failed.body).toContain('不符合 .mcp.json 的格式');
    fs.rmSync(path.join(src, 'mcp.json'));
  });

  test('Codex：platform-mcp、工具 skill 与 src skill 并列在 .agents/skills/；mcp_servers 写进 config.toml；删除只删 src skill', async () => {
    const draft = await openDraft('codex', `cfg-codex-${marker}`);
    const skills = path.join(draft.dir, '.agents/skills');
    const workflowId = `cfg-codex-${marker}`;
    expect(dirs(skills)).toEqual([...toolSkills, 'platform-mcp', workflowId, 'stage-1'].sort());
    expect(fs.existsSync(path.join(draft.dir, 'claude-config/skills'))).toBe(false);
    const src = path.join(draft.dir, 'src');
    writeSkill(src, 'extra', '第一版');
    await within(1000, () => fs.existsSync(path.join(skills, 'extra/SKILL.md')));
    fs.rmSync(path.join(src, 'skills/stage-1'), { recursive: true });
    fs.rmSync(path.join(src, 'skills/extra'), { recursive: true });
    await within(1000, () => !fs.existsSync(path.join(skills, 'stage-1')));
    await within(1000, () => !fs.existsSync(path.join(skills, 'extra')));
    expect(dirs(skills)).toEqual([...toolSkills, 'platform-mcp', workflowId].sort());

    fs.writeFileSync(path.join(src, 'mcp.json'), JSON.stringify(mcpFile));
    await restart(draft.liveId);
    const toml: unknown = parseToml(
      fs.readFileSync(path.join(draft.dir, 'codex-home/config.toml'), 'utf8'),
    );
    expect(toml).toMatchObject({
      projects: { [draft.dir]: { trust_level: 'trusted' } },
      mcp_servers: {
        linear: {
          command: 'npx',
          args: ['-y', 'mcp-remote', 'https://mcp.linear.app/mcp'],
          env: { WF_MCP_COMPONENT: 'test' },
        },
        docs: { url: 'https://example.invalid/mcp', http_headers: { 'X-Test': '1' } },
      },
    });
    // sse 传输 Codex 不支持：resume 以原文失败
    fs.writeFileSync(
      path.join(src, 'mcp.json'),
      JSON.stringify({ mcpServers: { old: { type: 'sse', url: 'https://example.invalid/sse' } } }),
    );
    await app.inject({ method: 'POST', url: `/api/live/${draft.liveId}/stop` });
    const failed = await app.inject({
      method: 'POST',
      url: `/api/live/${draft.liveId}/draft-resume`,
    });
    expect(failed.statusCode).toBe(400);
    expect(failed.body).toContain('Codex 不支持');
    fs.rmSync(path.join(src, 'mcp.json'));
    // 进程结束后不再随写随装（下次启动或 resume 前同步）
    const closed = await app.inject({ method: 'POST', url: `/api/live/${draft.liveId}/stop` });
    expect(closed.statusCode).toBeLessThan(500);
    writeSkill(src, 'late', '进程已结束');
    await sleep(600);
    expect(fs.existsSync(path.join(skills, 'late'))).toBe(false);
  });

  test('保存与构建：来源与构建日志写 Claude Code 草稿；variant 的 --mcp-config 有 src/mcp.json 的服务器；覆盖的历史写引擎', async () => {
    const src = path.join(claudeDraft.dir, 'src');
    fs.writeFileSync(path.join(src, 'mcp.json'), JSON.stringify(mcpFile));
    const saved = await app.inject({
      method: 'POST',
      url: `/api/workflow-drafts/${claudeDraft.id}/save`,
      payload: {
        workflow: { name: '会话配置', description: '打招呼' },
        target: { kind: 'new', name: '初稿', description: '第一版' },
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const variantId = saved.json<Draft>().savedVariantId ?? '';
    const log = async () =>
      (await app.inject({ method: 'GET', url: `/api/variants/${variantId}/build-log` })).body;
    expect(await log()).toContain(
      `=== 从 Claude Code 草稿 ${claudeDraft.id} 保存（没有底子），需要构建 ===`,
    );
    const variant = (
      await app.inject({ method: 'GET', url: `/api/variants/${variantId}` })
    ).json<Variant>();
    expect(variant.draftId).toBe(claudeDraft.id);
    const built = await app.inject({ method: 'POST', url: `/api/variants/${variantId}/build` });
    expect(built.statusCode, built.body).toBeLessThan(300);
    const after = (
      await app.inject({ method: 'GET', url: `/api/variants/${variantId}` })
    ).json<Variant>();
    expect(after.buildStatus, after.buildError ?? '').toBe('built');
    const mcpConfig = readJson(path.join(config.variantsDir, variantId, 'mcp-config.json'));
    expect(mcpConfig).toMatchObject({
      mcpServers: { 'wf-history': { type: 'stdio' }, ...mcpFile.mcpServers },
    });
    expect(await log()).toContain('write-mcp-config');

    // 覆盖：mcp.json 改了，hash 随之改变；构建日志与历史写 Claude Code 草稿
    fs.writeFileSync(
      path.join(src, 'mcp.json'),
      JSON.stringify({ mcpServers: { 'wf-history': { command: 'x' } } }),
    );
    const overwritten = await app.inject({
      method: 'POST',
      url: `/api/workflow-drafts/${claudeDraft.id}/save`,
      payload: { target: { kind: 'overwrite', variantId, name: '初稿', description: '第二版' } },
    });
    expect(overwritten.statusCode, overwritten.body).toBe(200);
    expect(await log()).toContain(`=== 由 Claude Code 草稿 ${claudeDraft.id} 覆盖 src`);
    const history = (
      await app.inject({ method: 'GET', url: `/api/variants/${variantId}/history` })
    ).json<{ kind: string; draftId: string; draftEngine: string | null }[]>();
    expect(history.find((e) => e.kind === 'overwrite')).toMatchObject({
      draftId: claudeDraft.id,
      draftEngine: 'claude',
    });
    const replaced = (
      await app.inject({ method: 'GET', url: `/api/variants/${variantId}` })
    ).json<Variant>();
    expect(replaced.skillsHash).not.toBe(variant.skillsHash);
    // 与 dashboard 提供的 wf-history 同名：构建以原文失败
    const failed = await app.inject({ method: 'POST', url: `/api/variants/${variantId}/build` });
    expect(failed.body).toContain('src/mcp.json 中的 wf-history 与 dashboard 提供的同名');
    await app.inject({ method: 'POST', url: `/api/live/${claudeDraft.liveId}/stop` });
  });
});
