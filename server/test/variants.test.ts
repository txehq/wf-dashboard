import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { type AppEvent, events } from '../src/events.js';
import { createVariants, type Variant } from '../src/variants/index.js';
import { wfSandboxProfile } from '../src/variants/sandbox.js';
import { listSkillFiles } from '../src/variants/skills.js';

// 真实构建：runtime 二进制与 cargo target 缓存在 .work/test-data，跨测试运行复用
const dataDir = path.join(config.repoRoot, '.work', 'test-data');
const dbFile = path.join(config.repoRoot, '.work', 'test-db', `${randomUUID()}.sqlite`);
const db = openDatabase(dbFile, config.migrationsDir);
const published: AppEvent[] = [];
const unsubscribe = events.subscribe((event) => published.push(event));
const variants = createVariants({
  db,
  dataDir,
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
});

const marker = `W6-EVAL-${randomUUID().slice(0, 8)}`;
const interview = 'skills/interview/SKILL.md';

// 真实 home 下 wf 管理的 skill 与 generation：路径、大小、mtime 与内容 hash
const watched = [
  path.join(os.homedir(), '.claude/skills'),
  path.join(os.homedir(), 'Library/Application Support/wf/state/generations'),
];
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (p: string) => {
    const stat = fs.lstatSync(p);
    if (stat.isDirectory()) {
      out[p] = `d ${String(stat.mtimeMs)}`;
      for (const name of fs.readdirSync(p)) walk(path.join(p, name));
      return;
    }
    const sha = stat.isFile()
      ? createHash('sha256').update(fs.readFileSync(p)).digest('hex')
      : fs.readlinkSync(p);
    out[p] = `${String(stat.size)} ${String(stat.mtimeMs)} ${sha}`;
  };
  for (const root of watched) walk(root);
  return out;
}

let before: Record<string, string>;
const created: Variant[] = [];
let base: Variant;
let mod: Variant;

beforeAll(() => {
  before = snapshot();
});

afterAll(() => {
  unsubscribe();
  db.$client.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
  for (const variant of created) {
    fs.rmSync(path.join(dataDir, 'variants', variant.id), { recursive: true, force: true });
  }
});

describe('variant 构建与隔离安装', { timeout: 1_800_000 }, () => {
  test('从 txe-workflow HEAD 建基线并派生', async () => {
    const { stdout: head } = await execa('git', [
      '-C',
      config.txeWorkflowRepo,
      'rev-parse',
      'HEAD',
    ]);
    base = await variants.createBaseline({
      name: `基线 ${marker}`,
    });
    created.push(base);
    expect(base.baseCommit).toBe(head.trim());
    expect(base.version).toMatch(/^\d+\.\d+\.\d+-eval\.[0-9a-f]{8}$/);
    expect(base.version.endsWith(base.skillsHash.slice(0, 8))).toBe(true);
    expect(variants.listFiles(base.id).map((f) => f.path)).toContain(interview);

    mod = variants.derive(base.id, { name: `修改 ${marker}` });
    created.push(mod);
    expect(mod.parentId).toBe(base.id);
    expect(mod.skillsHash).toBe(base.skillsHash);
    expect(mod.status).toBe('draft');
  });

  test('修改 interview/SKILL.md 后 hash、版本与 diff 随之变化', () => {
    const original = variants.readFile(mod.id, interview);
    // 改 frontmatter 的 description：skill 列表里能看到，也会触发 guard 的 GEN001 与 --fix
    const edited = `${original.replace('description: "', `description: "[${marker}] `)}\n<!-- eval variant: ${marker} -->\n`;
    expect(edited).not.toBe(original);
    mod = variants.writeFile(mod.id, interview, edited);
    expect(mod.skillsHash).not.toBe(base.skillsHash);
    expect(mod.version).not.toBe(base.version);

    const diff = variants.diff(mod.id, 'base');
    expect(diff.files.map((f) => f.path)).toEqual([interview]);
    expect(diff.files[0]?.status).toBe('modified');
    expect(diff.files[0]?.patch).toContain(`+<!-- eval variant: ${marker} -->`);
    expect(variants.diff(mod.id, 'parent').files).toHaveLength(1);
    expect(variants.diff(base.id, 'base').files).toHaveLength(0);
  });

  test('新建与删除 skill 内文件', () => {
    const extra = 'skills/interview/references/w6-note.md';
    const withExtra = variants.writeFile(mod.id, extra, '# note\n');
    expect(variants.listFiles(mod.id).map((f) => f.path)).toContain(extra);
    expect(variants.diff(mod.id, 'base').files.find((f) => f.path === extra)?.status).toBe('added');
    const removed = variants.deleteFile(mod.id, extra);
    expect(removed.skillsHash).not.toBe(withExtra.skillsHash);
    expect(variants.diff(mod.id, 'base').files.map((f) => f.path)).toEqual([interview]);
  });

  test('拒绝 skills/ 以外的路径与路径穿越', () => {
    const bad = [
      'Cargo.toml',
      '../Cargo.toml',
      'skills/../Cargo.toml',
      'skills/interview/../../Cargo.toml',
      '/etc/passwd',
      'skills/./interview/SKILL.md',
      'skills/interview\\..\\..\\Cargo.toml',
      'skills/SKILL.md',
    ];
    for (const file of bad) {
      expect(() => variants.writeFile(mod.id, file, 'x'), file).toThrow(/只允许编辑/);
      expect(() => variants.readFile(mod.id, file), file).toThrow(/只允许编辑/);
      expect(() => variants.deleteFile(mod.id, file), file).toThrow(/只允许编辑/);
    }
  });

  test('构建并隔离安装修改过的 variant', async () => {
    mod = await variants.build(mod.id);
    expect(mod.buildStatus).toBe('built');
    expect(mod.builtHash).toBe(mod.skillsHash);
    const dirs = variants.layout(mod.id);

    // 隔离目录的 skills 与 src/skills 逐字节相同
    const installed = path.join(dirs.claudeDir, 'skills');
    const srcFiles = listSkillFiles(dirs.src).map((f) => f.slice('skills/'.length));
    const installedFiles = fs
      .readdirSync(installed, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(installed, path.join(entry.parentPath, entry.name)))
      .sort();
    expect(installedFiles).toEqual(srcFiles);
    for (const file of srcFiles) {
      expect(fs.readFileSync(path.join(installed, file)), file).toEqual(
        fs.readFileSync(path.join(dirs.skills, file)),
      );
    }
    expect(fs.readFileSync(path.join(installed, 'interview/SKILL.md'), 'utf8')).toContain(marker);

    // Cargo.toml 只有 [workspace.package].version 一行变化
    const baseCargo = fs
      .readFileSync(path.join(dataDir, 'bases', mod.baseCommit, 'src/Cargo.toml'), 'utf8')
      .split('\n');
    const modCargo = fs.readFileSync(path.join(dirs.src, 'Cargo.toml'), 'utf8').split('\n');
    expect(modCargo).toHaveLength(baseCargo.length);
    const changed = modCargo.filter((line, i) => line !== baseCargo[i]);
    expect(changed).toEqual([`version = "${mod.version}"`]);

    const status = await execa(
      'sandbox-exec',
      ['-p', wfSandboxProfile(dirs.dir), dirs.wfBin, 'status'],
      {
        env: {
          PATH: z.string().parse(process.env.PATH),
          HOME: os.homedir(),
          WF_HOME: dirs.wfHome,
          CLAUDE_CONFIG_DIR: dirs.claudeDir,
          CODEX_HOME: dirs.codexHome,
          TMPDIR: dirs.tmp,
        },
        extendEnv: false,
      },
    );
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain(mod.version);

    const log = variants.buildLog(mod.id);
    fs.writeFileSync(path.join(config.repoRoot, '.work', 'w6-build.log'), log);
    for (const step of ['guard-fix', 'guard', 'build-local', 'install', 'unregister-codex']) {
      expect(log).toContain(`[${step}] exit 0`);
    }
    // 事件总线上依次出现构建开始、各步骤与完成
    const buildEvents = published.filter(
      (event) => event.type === 'variant.build' && event.variantId === mod.id,
    );
    expect(buildEvents[0]).toEqual({
      type: 'variant.build',
      variantId: mod.id,
      status: 'building',
      step: null,
    });
    expect(buildEvents).toContainEqual({
      type: 'variant.build',
      variantId: mod.id,
      status: 'building',
      step: 'install',
    });
    expect(buildEvents.at(-1)).toEqual({
      type: 'variant.build',
      variantId: mod.id,
      status: 'built',
      step: null,
    });
  });

  test('用 runtimeEnv 运行 claude，加载修改过的 skill，不读入真实 CLAUDE.md', async () => {
    const runtime = variants.runtimeEnv(mod.id);
    for (const key of Object.keys(runtime.env)) {
      expect(key).not.toMatch(/^(CLAUDE(?!_CONFIG_DIR$)|ANTHROPIC|ORCA_AGENT)/);
    }
    const work = path.join(variants.layout(mod.id).dir, 'work', 'probe');
    fs.mkdirSync(work, { recursive: true });
    await execa('git', ['init', '-q'], { cwd: work });
    // 与 runner 相同：run 的 sandbox，session 写到 projects/<runId>/
    const runId = 'r-20261010-probe1';
    const result = await execa(
      'sandbox-exec',
      [
        '-p',
        variants.sandboxProfile(mod.id, runId, path.join(dataDir, 'runs'), null),
        'claude',
        '-p',
        '列出可用 skill 名称',
        '--output-format',
        'json',
        '--permission-mode',
        'bypassPermissions',
        // 与 runner 相同：模型与 effort 由 run 决定，放在 variant 的参数之前
        '--model',
        'opus',
        '--effort',
        'high',
        ...runtime.claudeArgs,
      ],
      {
        cwd: work,
        env: { ...runtime.env, CLAUDE_CODE_PROJECT_DIR_NAME: runId },
        extendEnv: false,
        stdin: 'ignore',
      },
    );
    const output = z
      .looseObject({ is_error: z.boolean(), result: z.string(), session_id: z.string() })
      .parse(JSON.parse(result.stdout));
    fs.mkdirSync(path.join(config.repoRoot, '.work'), { recursive: true });
    fs.writeFileSync(path.join(config.repoRoot, '.work', 'w6-claude-probe.json'), result.stdout);
    expect(output.is_error).toBe(false);
    for (const name of ['interview', 'lfg', 'ic', 'research']) {
      expect(output.result).toContain(name);
    }

    // session jsonl 写在隔离目录；其中的 skill 列表带着改过的 description
    const sessionFile = fs
      .readdirSync(runtime.sessionsDir, { recursive: true, encoding: 'utf8' })
      .find((file) => file.endsWith(`${output.session_id}.jsonl`));
    if (sessionFile === undefined) throw new Error('隔离目录里没有这次运行的 session jsonl');
    const transcript = fs.readFileSync(path.join(runtime.sessionsDir, sessionFile), 'utf8');
    expect(transcript).toContain('skill_listing');
    expect(transcript).toContain(`[${marker}]`);

    // 读入的 CLAUDE.md 只有隔离目录里那一份（wf 装进去的内容与真实文件相同，所以按路径判定）
    const Instructions = z.object({
      attachment: z.object({
        type: z.literal('instructions'),
        files: z.array(z.object({ path: z.string(), type: z.string() })),
      }),
    });
    const loaded = transcript
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => Instructions.safeParse(JSON.parse(line)))
      .flatMap((parsed) => (parsed.success ? parsed.data.attachment.files : []));
    expect(loaded.map((f) => f.path)).toEqual([
      path.join(variants.layout(mod.id).claudeDir, 'CLAUDE.md'),
    ]);
    const realClaude = path.join(os.homedir(), '.claude');
    expect(loaded.every((f) => !f.path.startsWith(`${realClaude}/`))).toBe(true);
    const settings = z
      .object({ claudeMdExcludes: z.array(z.string()) })
      .parse(
        JSON.parse(
          fs.readFileSync(path.join(variants.layout(mod.id).claudeDir, 'settings.json'), 'utf8'),
        ),
      );
    expect(settings.claudeMdExcludes).toEqual([
      path.join(realClaude, 'CLAUDE.md'),
      path.join(realClaude, 'rules/**'),
    ]);
  });

  test('冻结后拒绝写入', async () => {
    mod = variants.freeze(mod.id);
    expect(mod.status).toBe('frozen');
    expect(() => variants.writeFile(mod.id, interview, 'x')).toThrow(/已冻结/);
    expect(() => variants.deleteFile(mod.id, interview)).toThrow(/已冻结/);
    await expect(variants.build(mod.id)).rejects.toThrow(/已冻结/);
    // 派生只能在同一 workflow 内
    expect(() =>
      variants.derive(mod.id, { name: `跨 workflow ${marker}`, workflowId: 'next-workflow' }),
    ).toThrow(/派生只能在同一 workflow 内/);
    // 冻结的 variant 仍可派生出新的 draft
    const copy = variants.derive(mod.id, { name: `另存 ${marker}` });
    created.push(copy);
    expect(copy.status).toBe('draft');
    expect(copy.skillsHash).toBe(mod.skillsHash);
  });

  test('真实 ~/.claude/skills 与 wf generations 未被改动', () => {
    expect(snapshot()).toEqual(before);
  });
});
