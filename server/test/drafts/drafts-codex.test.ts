import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execaSync } from 'execa';
import { afterAll, describe, expect, test } from 'vitest';
import { z } from 'zod';

// 真实档（Contracts 17.5）：唯一一次真实调用 Codex。在草稿目录中启动交互的 codex（node-pty，workspace-write 加网络，
// CODEX_HOME 与 HOME 都是草稿自己的目录），提示只有一句"在 src/skills/hello-flow/SKILL.md 末尾加一行 ok"，
// 等文件出现这一行后结束进程；记录耗时与 token。草稿目录由 drafts.open 建（不装 skill，不跑完整的生成）
const work = path.resolve(import.meta.dirname, '../../../.work/test-drafts-codex', randomUUID());
const repo = path.join(work, 'txe-workflow');
fs.mkdirSync(path.join(repo, 'skills/hello-flow'), { recursive: true });
fs.writeFileSync(
  path.join(repo, 'skills/hello-flow/SKILL.md'),
  '---\nname: hello-flow\ndescription: 测试\n---\n\n# hello-flow\n',
);
fs.writeFileSync(path.join(repo, 'Cargo.toml'), '[workspace.package]\nversion = "0.1.0"\n');
const identity = ['-c', 'user.name=wf-dashboard', '-c', 'user.email=wf@example.invalid'];
const git = (...args: string[]) => execaSync('git', ['-C', repo, ...identity, ...args]);
git('init', '--quiet', '--initial-branch', 'main');
git('add', '.');
git('commit', '--quiet', '-m', 'skills');
process.env.WFD_TXE_WORKFLOW = repo;

const { config } = await import('../../src/config.js');
const { openDatabase } = await import('../../src/db/index.js');
const { createDrafts } = await import('../../src/drafts/index.js');
const { copyDraftSource, draftLayout, writeDraftDocs } = await import('../../src/drafts/dir.js');
const { loadWorkflow } = await import('../../src/workflows/index.js');
const { createLive } = await import('../../src/live/index.js');
const { rolloutFiles } = await import('../../src/live/codex.js');
const { createSettingsStore } = await import('../../src/runs/settings.js');
const { createVariants } = await import('../../src/variants/index.js');
const { testCodex } = await import('../helpers/codex.js');
const { testRepos } = await import('../helpers/local-repos.js');

const dbFile = path.join(config.repoRoot, '.work', 'test-db', `${randomUUID()}.sqlite`);
const db = openDatabase(dbFile, config.migrationsDir);
const variants = createVariants({
  db,
  dataDir: config.dataDir,
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
});
const live = createLive({
  db,
  variants,
  settings: createSettingsStore(db),
  vaultDir: config.vaultDir,
  product: config.evalProduct,
  liveDir: config.liveDir,
  dataDir: config.dataDir,
  serverUrl: () => 'http://127.0.0.1:1',
  localHome: path.join(config.dataDir, 'home'),
  repos: testRepos(),
  codex: { ...testCodex('codex'), sessionTimeoutMs: 120_000 },
  claudeBin: config.claudeBin,
  autoStop: { idleMs: config.liveAutoStopMs, graceMs: config.liveStopGraceMs },
});
const drafts = createDrafts({
  db,
  variants,
  live,
  draftsDir: config.workflowDraftsDir,
  dataDir: config.dataDir,
  skillSources: config.codexSkillSources,
});

afterAll(async () => {
  await live.shutdown();
  db.$client.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

const TokenUsage = z.looseObject({
  input_tokens: z.number(),
  cached_input_tokens: z.number(),
  output_tokens: z.number(),
  reasoning_output_tokens: z.number(),
});
const TokenCount = z.looseObject({
  type: z.literal('event_msg'),
  payload: z.looseObject({
    type: z.literal('token_count'),
    info: z.looseObject({ total_token_usage: TokenUsage }).nullable(),
  }),
});

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

describe('Live 中的 Codex 会话（真实 Codex，一次）', { timeout: 600_000 }, () => {
  test('启动交互的 codex，在草稿目录中按一句提示写一行，然后结束', async () => {
    const base = await variants.createBaseline({ name: `codex 底子 ${randomUUID().slice(0, 6)}` });
    // 草稿目录只做前两步（复制 src、写说明与例子），不装 skill；Codex 的项换成一句话的提示，不跑完整的生成
    const { draft } = drafts.open({
      mode: 'variant',
      engine: 'codex',
      workflowId: 'lfg',
      requirement: '测试',
      baseVariantId: base.id,
    });
    await copyDraftSource(draftLayout(draft.dir, 'variant'), (dest) =>
      variants.exportSource(base.id, dest),
    );
    writeDraftDocs(draftLayout(draft.dir, 'variant'), 'variant', loadWorkflow(db, 'lfg'), 'codex');
    const file = path.join(draft.dir, 'src/skills/hello-flow/SKILL.md');
    const started = Date.now();
    const item = live.createDraftItem({
      cwd: draft.dir,
      prompt: '在 src/skills/hello-flow/SKILL.md 末尾加一行 ok',
      title: 'W42 真实 Codex',
      workflow: 'lfg',
      purpose: 'design',
      engine: 'codex',
    });
    const detail = await live.startDraft(item.id);
    expect(detail.engine).toBe('codex');
    expect(detail.status).toBe('running');
    let lines: string[] = [];
    while (Date.now() - started < 300_000) {
      lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
      if (lines.at(-1)?.trim() === 'ok') break;
      await sleep(1000);
    }
    const seconds = (Date.now() - started) / 1000;
    expect(lines.at(-1)?.trim()).toBe('ok');
    // 等这一轮的 token 写进 rollout 再结束
    await sleep(5000);
    const stopped = await live.stop(detail.id);
    expect(stopped.status).toBe('exited');
    const [rollout] = rolloutFiles(path.join(draft.dir, 'codex-home'));
    if (rollout === undefined) throw new Error('没有 rollout');
    expect(rollout.endsWith(`-${detail.claudeSessionId ?? '（没有会话 id）'}.jsonl`)).toBe(true);
    const usage = fs
      .readFileSync(rollout, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => TokenCount.safeParse(JSON.parse(l)))
      .flatMap((r) => (r.success && r.data.payload.info !== null ? [r.data.payload.info] : []))
      .at(-1)?.total_token_usage;
    // 草稿外没有被写入：HOME 下没有用户的 skill 目录，CODEX_HOME 在草稿中
    expect(fs.existsSync(path.join(draft.dir, 'home/.agents'))).toBe(false);
    console.info(
      `[W42 真实 Codex] 写入 ok 用时 ${String(seconds)} 秒；token ${JSON.stringify(usage ?? null)}`,
    );
  });
});
