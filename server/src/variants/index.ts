import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, patch } from '@decimalturn/toml-patch';
import { createTwoFilesPatch } from 'diff';
import { desc, and, eq } from 'drizzle-orm';
import { execa } from 'execa';
import { z } from 'zod';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import { variants } from '../db/schema.js';
import { events } from '../events.js';
import { claudeSettingsEnv } from '../llm/client.js';
import { loadWorkflow, syncBuiltinWorkflows } from '../workflows/index.js';
import { DEV_WORKFLOW_ID, requiredSkills } from '../workflows/schema.js';
import { BuildLog } from './build-log.js';
import { writeCodexHome } from './codex-home.js';
import { HttpError } from './errors.js';
import { dataLayout, type VariantLayout } from './layout.js';
import { claudeSandboxProfile, wfSandboxProfile } from './sandbox.js';
import { REGISTRY_FILES, registerSkills } from './skill-registry.js';
import { listSkillFiles, resolveSkillPath, skillsHash } from './skills.js';

export type Variant = typeof variants.$inferSelect;

export interface VariantsOptions {
  db: Db;
  dataDir: string;
  // txe-workflow 仓库
  repo: string;
  ctxBin: string;
  // gateway 认证 env 的来源，默认 config.claudeSettingsPath
  claudeSettingsPath?: string | undefined;
  // Codex 登录凭据的来源，默认 config.codexAuthPath
  codexAuthPath?: string | undefined;
  // Codex 模型配置的来源，默认 config.codexConfigPath
  codexConfigPath?: string | undefined;
  // variant 新建或 skills 内容变化之后调用：session 的自动绑定据此重新判定（Contracts 15.1）
  onSkillsChanged?: (() => void) | undefined;
}

export interface SkillFile {
  path: string;
  size: number;
}

export interface FileDiff {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldContent: string;
  newContent: string;
  // 统一 diff 文本
  patch: string;
}

export interface VariantDiff {
  against: { kind: 'parent' | 'base'; variantId: string | null; commit: string };
  files: FileDiff[];
}

// runner 在 variant 中启动 claude 所需的一切；运行目录及其上级不能有 CLAUDE.md 或 .claude/
export interface RuntimeEnv {
  // 完整的子进程环境：父进程环境去掉 CLAUDE*、ANTHROPIC*、ORCA_AGENT* 后加上 variant 变量
  env: Record<string, string> & {
    CLAUDE_CONFIG_DIR: string;
    WF_HOME: string;
    CODEX_HOME: string;
    TMPDIR: string;
    PATH: string;
  };
  mcpConfigPath: string;
  // --model、--effort 与 --mcp-config
  claudeArgs: string[];
  // claude 写 session jsonl 的目录，Ingester 的来源
  sessionsDir: string;
}

// loose：patch 需要完整的文档，未声明的键必须原样保留
const CargoManifest = z.looseObject({
  workspace: z.looseObject({ package: z.looseObject({ version: z.string() }) }),
});

const IsolatedSettings = z.looseObject({
  env: z.record(z.string(), z.unknown()).optional(),
  claudeMdExcludes: z.array(z.string()).optional(),
});

const ClaudeState = z.looseObject({ hasCompletedOnboarding: z.boolean().optional() });

function readWorkspaceVersion(srcDir: string): string {
  return CargoManifest.parse(parse(fs.readFileSync(path.join(srcDir, 'Cargo.toml'), 'utf8')))
    .workspace.package.version;
}

function processEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

// 父进程是 Claude Code 或 Orca 时，这些变量会覆盖 variant 的隔离设置
function isolatedBaseEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(processEnv()).filter(
      ([key]) =>
        !key.startsWith('CLAUDE') && !key.startsWith('ANTHROPIC') && !key.startsWith('ORCA_AGENT'),
    ),
  );
}

export function createVariants({
  db,
  dataDir,
  repo,
  ctxBin,
  claudeSettingsPath,
  codexAuthPath = config.codexAuthPath,
  codexConfigPath = config.codexConfigPath,
  onSkillsChanged = () => undefined,
}: VariantsOptions) {
  const layout = dataLayout(dataDir);
  const runtimeBuilds = new Map<string, Promise<void>>();

  // 把 settings 源的 env 块合并进 variant 的 settings.json，其他字段原样保留；返回合并的键。
  // 先写临时文件再 rename：同一 variant 的并发 run 不会读到写了一半的文件
  function writeIsolatedSettings(
    claudeDir: string,
    edit: (settings: z.infer<typeof IsolatedSettings>) => void = () => undefined,
  ): string[] {
    const file = path.join(claudeDir, 'settings.json');
    const settings = IsolatedSettings.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    const sourceEnv = claudeSettingsEnv(claudeSettingsPath);
    settings.env = { ...settings.env, ...sourceEnv };
    edit(settings);
    const tmp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return Object.keys(sourceEnv);
  }

  // Claude Code 的首次引导（主题、安全提示）只在交互启动时出现，状态记在 <CLAUDE_CONFIG_DIR>/.claude.json；
  // variant 的配置目录由 dashboard 所有，写入引导已完成（Contracts 14.2）。已经写过时不改动文件
  function markOnboardingDone(claudeDir: string) {
    const file = path.join(claudeDir, '.claude.json');
    const state = fs.existsSync(file)
      ? ClaudeState.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
      : {};
    if (state.hasCompletedOnboarding === true) return;
    const tmp = `${file}.${randomUUID()}.tmp`;
    const content = `${JSON.stringify({ ...state, hasCompletedOnboarding: true }, null, 2)}\n`;
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  // 上次服务退出时仍在构建的 variant 不会再完成
  db.update(variants)
    .set({ buildStatus: 'failed', buildError: '服务重启，构建中断' })
    .where(eq(variants.buildStatus, 'building'))
    .run();

  function get(id: string): Variant {
    const row = db.select().from(variants).where(eq(variants.id, id)).get();
    if (row === undefined) throw new HttpError(404, `variant 不存在：${id}`);
    return row;
  }

  function assertDraft(row: Variant) {
    if (row.status === 'frozen') {
      throw new HttpError(409, `variant ${row.name} 已冻结，修改需要另存为新 variant`);
    }
  }

  // 从其他数据目录导入的 variant 只有 src/skills，没有安装目录：不能编辑、构建与运行，只能派生
  function assertInstallable(row: Variant) {
    if (row.installDir === null) {
      throw new HttpError(
        409,
        `variant ${row.name} 是导入的，只有 skill 内容；派生为新 variant 后才能编辑、构建与运行`,
      );
    }
  }

  // 名字在同一 workflow 内唯一（Contracts 16.4）
  function assertNameFree(workflowId: string, name: string) {
    const taken = db
      .select()
      .from(variants)
      .where(and(eq(variants.workflowId, workflowId), eq(variants.name, name)))
      .get();
    if (taken !== undefined) throw new HttpError(409, `名称已被使用：${name} (${workflowId})`);
  }

  // 新 variant 的 src：导入的 variant 只有 src/skills，由基线导出加上它的 skills 组成
  function copySource(source: Variant, id: string) {
    const base = layout.base(source.baseCommit);
    if (!fs.existsSync(base)) {
      throw new HttpError(409, `基线 ${source.baseCommit} 的导出不存在：${base}`);
    }
    const dirs = layout.variant(id);
    fs.mkdirSync(dirs.dir, { recursive: true });
    const copy = (from: string, to: string) => {
      fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    };
    if (source.installDir === null) {
      copy(base, dirs.src);
      fs.rmSync(dirs.skills, { recursive: true, force: true });
      copy(layout.variant(source.id).skills, dirs.skills);
    } else {
      copy(layout.variant(source.id).src, dirs.src);
    }
    return dirs;
  }

  // 从 source 复制出新的 draft，属于 workflowId
  function copyVariant(
    source: Variant,
    input: { name: string; workflowId: string; note: string },
  ): Variant {
    assertNameFree(input.workflowId, input.name);
    const id = randomUUID();
    const dirs = copySource(source, id);
    fs.writeFileSync(dirs.buildLog, `=== ${input.note} ===\n`);
    const hash = skillsHash(dirs.src);
    db.insert(variants)
      .values({
        id,
        name: input.name,
        workflowId: input.workflowId,
        parentId: source.id,
        baseCommit: source.baseCommit,
        skillsHash: hash,
        version: versionFor(source.baseCommit, hash),
        installDir: dirs.dir,
      })
      .run();
    onSkillsChanged();
    return get(id);
  }

  function versionFor(commit: string, hash: string): string {
    return `${readWorkspaceVersion(layout.base(commit))}-eval.${hash.slice(0, 8)}`;
  }

  async function exportCommit(commit: string, dest: string, log: BuildLog) {
    fs.mkdirSync(dest, { recursive: true });
    const tar = `${dest}.tar`;
    const options = { cwd: path.dirname(dest), env: processEnv() };
    await log.run(
      'archive',
      'git',
      ['-C', repo, 'archive', '--format=tar', '-o', tar, commit],
      options,
    );
    await log.run('extract', 'tar', ['-xf', tar, '-C', dest], options);
    fs.rmSync(tar);
  }

  // 每个基线 commit 编译一次 wf，同一基线的 variant 共用
  async function buildRuntime(commit: string, log: BuildLog) {
    const dir = layout.runtimeDir(commit);
    const src = layout.runtimeSrc(commit);
    fs.rmSync(dir, { recursive: true, force: true });
    await exportCommit(commit, src, log);
    // runtime 用基线原样的版本号编译，Cargo.lock 无需改写
    await log.run('cargo-build', 'cargo', ['build', '--locked', '-p', 'wf-cli'], {
      cwd: src,
      env: { ...processEnv(), CARGO_TARGET_DIR: layout.cargoTarget },
    });
    const partial = `${layout.runtimeBin(commit)}.partial`;
    fs.copyFileSync(path.join(layout.cargoTarget, 'debug', 'wf'), partial);
    fs.renameSync(partial, layout.runtimeBin(commit));
  }

  async function ensureRuntime(commit: string, log: BuildLog) {
    if (fs.existsSync(layout.runtimeBin(commit))) {
      log.append(`\n[runtime] 复用 ${layout.runtimeBin(commit)}\n`);
      return;
    }
    let pending = runtimeBuilds.get(commit);
    if (pending === undefined) {
      pending = buildRuntime(commit, log).finally(() => runtimeBuilds.delete(commit));
      runtimeBuilds.set(commit, pending);
    } else {
      log.append(`\n[runtime] 等待另一个构建编译 ${commit} 的 wf\n`);
    }
    await pending;
  }

  function newLog(row: Variant) {
    return new BuildLog(
      layout.variant(row.id).buildLog,
      (step) => {
        events.publish({ type: 'variant.build', variantId: row.id, status: 'building', step });
      },
      (message) => {
        db.update(variants)
          .set({ buildStatus: 'failed', buildError: message })
          .where(eq(variants.id, row.id))
          .run();
        events.publish({ type: 'variant.build', variantId: row.id, status: 'failed', step: null });
      },
    );
  }

  // 编辑后重新计算 hash 与版本号；内容变化后原有构建作废
  function afterEdit(row: Variant): Variant {
    const hash = skillsHash(layout.variant(row.id).src);
    if (hash !== row.skillsHash) {
      db.update(variants)
        .set({ skillsHash: hash, version: versionFor(row.baseCommit, hash), buildStatus: 'none' })
        .where(eq(variants.id, row.id))
        .run();
      onSkillsChanged();
    }
    return get(row.id);
  }

  function readTree(srcDir: string): Map<string, string> {
    return new Map(
      listSkillFiles(srcDir).map((file) => [
        file,
        fs.readFileSync(path.join(srcDir, file), 'utf8'),
      ]),
    );
  }

  function diffTrees(beforeDir: string, afterDir: string): FileDiff[] {
    const before = readTree(beforeDir);
    const after = readTree(afterDir);
    const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
    const files: FileDiff[] = [];
    for (const file of paths) {
      const oldContent = before.get(file);
      const newContent = after.get(file);
      if (oldContent === newContent) continue;
      files.push({
        path: file,
        status:
          oldContent === undefined ? 'added' : newContent === undefined ? 'removed' : 'modified',
        oldContent: oldContent ?? '',
        newContent: newContent ?? '',
        patch: createTwoFilesPatch(
          oldContent === undefined ? '/dev/null' : `a/${file}`,
          newContent === undefined ? '/dev/null' : `b/${file}`,
          oldContent ?? '',
          newContent ?? '',
        ),
      });
    }
    return files;
  }

  return {
    list(): Variant[] {
      return db.select().from(variants).orderBy(desc(variants.createdAt)).all();
    },

    get,

    layout(id: string): VariantLayout {
      get(id);
      return layout.variant(id);
    },

    async createBaseline(input: {
      name: string;
      commit?: string | undefined;
      // 默认 dev-workflow
      workflowId?: string | undefined;
    }): Promise<Variant> {
      const workflowId = input.workflowId ?? DEV_WORKFLOW_ID;
      loadWorkflow(db, workflowId);
      assertNameFree(workflowId, input.name);
      const { stdout } = await execa('git', [
        '-C',
        repo,
        'rev-parse',
        '--verify',
        `${input.commit ?? 'HEAD'}^{commit}`,
      ]);
      const commit = stdout.trim();
      const id = randomUUID();
      const dirs = layout.variant(id);
      fs.mkdirSync(dirs.dir, { recursive: true });
      const log = new BuildLog(
        dirs.buildLog,
        () => undefined,
        () => undefined,
      );
      log.append(`=== 导出基线 ${commit} ${new Date().toISOString()} ===\n`);
      if (!fs.existsSync(layout.base(commit))) await exportCommit(commit, layout.base(commit), log);
      await exportCommit(commit, dirs.src, log);
      const hash = skillsHash(dirs.src);
      db.insert(variants)
        .values({
          id,
          name: input.name,
          workflowId,
          parentId: null,
          baseCommit: commit,
          skillsHash: hash,
          version: versionFor(commit, hash),
          installDir: dirs.dir,
        })
        .run();
      // dev-workflow 还没有底子时以最早导入的基线为底子
      syncBuiltinWorkflows(db);
      onSkillsChanged();
      return get(id);
    },

    // 从任一 variant（含已冻结的）复制出新的 draft，只能在同一 workflow 内（Contracts 16.4）。导入的 variant
    // 只有 src/skills：新 variant 的 src 由基线导出加上它的 skills 组成，未修改时 skills hash 与它相同
    derive(sourceId: string, input: { name: string; workflowId?: string | undefined }): Variant {
      const source = get(sourceId);
      if (input.workflowId !== undefined && input.workflowId !== source.workflowId) {
        throw new HttpError(
          400,
          `variant ${source.name} 属于 workflow ${source.workflowId}，不能派生到 ${input.workflowId}：派生只能在同一 workflow 内，跨 workflow 请新建 workflow`,
        );
      }
      return copyVariant(source, {
        name: input.name,
        workflowId: source.workflowId,
        note: `从 ${source.name}（${source.id}）派生`,
      });
    },

    // 新建 workflow 时：复制 source 的基线导出与 src/skills，作为新 workflow 的底子（Contracts 16.4）
    copyToWorkflow(sourceId: string, input: { workflowId: string; name: string }): Variant {
      const source = get(sourceId);
      loadWorkflow(db, input.workflowId);
      return copyVariant(source, {
        name: input.name,
        workflowId: input.workflowId,
        note: `从 ${source.name}（${source.id}，${source.workflowId}）复制为 workflow ${input.workflowId} 的底子`,
      });
    },

    listFiles(id: string): SkillFile[] {
      get(id);
      const src = layout.variant(id).src;
      return listSkillFiles(src).map((file) => ({
        path: file,
        size: fs.statSync(path.join(src, file)).size,
      }));
    },

    readFile(id: string, file: string): string {
      get(id);
      const absolute = resolveSkillPath(layout.variant(id).src, file);
      if (!fs.statSync(absolute, { throwIfNoEntry: false })?.isFile()) {
        throw new HttpError(404, `文件不存在：${file}`);
      }
      return fs.readFileSync(absolute, 'utf8');
    },

    // 保存或新建 skills/ 内的文件
    writeFile(id: string, file: string, content: string): Variant {
      const row = get(id);
      assertInstallable(row);
      assertDraft(row);
      const absolute = resolveSkillPath(layout.variant(id).src, file);
      if (fs.statSync(absolute, { throwIfNoEntry: false })?.isDirectory()) {
        throw new HttpError(400, `路径是目录：${file}`);
      }
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content);
      return afterEdit(row);
    },

    deleteFile(id: string, file: string): Variant {
      const row = get(id);
      assertInstallable(row);
      assertDraft(row);
      const skillsDir = layout.variant(id).skills;
      const absolute = resolveSkillPath(layout.variant(id).src, file);
      if (!fs.statSync(absolute, { throwIfNoEntry: false })?.isFile()) {
        throw new HttpError(404, `文件不存在：${file}`);
      }
      fs.rmSync(absolute);
      // 删除因此变空的上级目录，直到 skills/
      for (let dir = path.dirname(absolute); dir !== skillsDir; dir = path.dirname(dir)) {
        if (fs.readdirSync(dir).length > 0) break;
        fs.rmdirSync(dir);
      }
      return afterEdit(row);
    },

    // 与 parent 或基线 commit 逐文件对比 skills/
    diff(id: string, against: 'parent' | 'base'): VariantDiff {
      const row = get(id);
      let reference: string;
      let variantId: string | null = null;
      if (against === 'parent') {
        if (row.parentId === null) throw new HttpError(400, `variant ${row.name} 没有 parent`);
        variantId = row.parentId;
        reference = layout.variant(row.parentId).src;
      } else {
        reference = layout.base(row.baseCommit);
      }
      return {
        against: { kind: against, variantId, commit: row.baseCommit },
        files: diffTrees(reference, layout.variant(id).src),
      };
    },

    // 任意两个 variant 之间逐文件对比 skills/，from 为旧的一侧
    diffBetween(fromId: string, toId: string): FileDiff[] {
      get(fromId);
      get(toId);
      return diffTrees(layout.variant(fromId).src, layout.variant(toId).src);
    },

    buildLog(id: string): string {
      get(id);
      return fs.readFileSync(layout.variant(id).buildLog, 'utf8');
    },

    // 构建并隔离安装；每次从空的 dist 与 home 开始
    async build(id: string): Promise<Variant> {
      const row = get(id);
      assertInstallable(row);
      assertDraft(row);
      if (row.buildStatus === 'building') throw new HttpError(409, `variant ${row.name} 正在构建`);
      db.update(variants)
        .set({ buildStatus: 'building', buildError: null })
        .where(eq(variants.id, id))
        .run();
      events.publish({ type: 'variant.build', variantId: id, status: 'building', step: null });

      const dirs = layout.variant(id);
      const log = newLog(row);
      log.append(`\n=== 构建 ${new Date().toISOString()} ===\n`);
      // 所属 workflow 的每个大阶段入口与小阶段都要有 skill（Contracts 16.1）
      const missing = requiredSkills(loadWorkflow(db, row.workflowId)).filter(
        (name) => !fs.existsSync(path.join(dirs.skills, name, 'SKILL.md')),
      );
      if (missing.length > 0) {
        log.fail(
          'check-skills',
          `variant ${row.name} 缺少 workflow ${row.workflowId} 要求的 skill：${missing.join('、')}（应为 src/skills/<名字>/SKILL.md）`,
        );
      }
      await ensureRuntime(row.baseCommit, log);
      const runtime = layout.runtimeBin(row.baseCommit);

      let started = performance.now();
      for (const dir of [dirs.dist, dirs.home, dirs.tmp]) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      for (const dir of [path.dirname(dirs.wfBin), dirs.claudeDir, dirs.codexHome, dirs.tmp]) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const hash = skillsHash(dirs.src);
      const version = versionFor(row.baseCommit, hash);
      const cargoPath = path.join(dirs.src, 'Cargo.toml');
      const cargo = fs.readFileSync(cargoPath, 'utf8');
      const manifest = CargoManifest.parse(parse(cargo));
      manifest.workspace.package.version = version;
      fs.writeFileSync(cargoPath, patch(cargo, manifest));
      log.note('version', started, `skills sha256 ${hash}，版本 ${version}`);

      const sandboxed = (step: string, wf: string, args: string[]) =>
        log.run(step, 'sandbox-exec', ['-p', wfSandboxProfile(dirs.dir), wf, ...args], {
          cwd: dirs.src,
          env: {
            ...isolatedBaseEnv(),
            WF_HOME: dirs.wfHome,
            CLAUDE_CONFIG_DIR: dirs.claudeDir,
            // wf install 会把检测到的 codex 登记为由 wf 管理，配置根目录取 CODEX_HOME
            CODEX_HOME: dirs.codexHome,
            TMPDIR: dirs.tmp,
          },
        });

      // 新增或删除的 skill 目录登记进 registry 与 docs 名单（Contracts 16.4），改动写回 src/ 并记进构建日志
      started = performance.now();
      const registration = registerSkills(dirs.src);
      log.note(
        'register-skills',
        started,
        registration.added.length === 0 && registration.removed.length === 0
          ? '没有新增或删除的 skill'
          : `登记 ${registration.added.join('、') || '（无）'}；删去 ${registration.removed.join('、') || '（无）'}（${REGISTRY_FILES.join('、')}）`,
      );
      // 改 skill frontmatter 时 docs/generated/skills.md 需要重新生成
      await sandboxed('guard-fix', runtime, ['guard', '--fix']);
      await sandboxed('guard', runtime, ['guard']);
      await sandboxed('build-local', runtime, [
        'release',
        'build-local',
        '--root',
        dirs.src,
        '--out',
        dirs.dist,
        '--version',
        version,
      ]);
      started = performance.now();
      // APFS 上是写时复制的克隆，不占额外空间
      fs.copyFileSync(runtime, dirs.wfBin, fs.constants.COPYFILE_FICLONE);
      log.note('copy-runtime', started, `${runtime} → ${dirs.wfBin}`);
      const source = `local:${dirs.dist}`;
      await sandboxed('install-dry-run', runtime, [
        'install',
        '--source',
        source,
        '--agent',
        'claude',
        '--dry-run',
      ]);
      await sandboxed('install', runtime, ['install', '--source', source, '--agent', 'claude']);
      // 只让 wf 管理隔离的 Claude 目录；之后不带 --agent 的 repair、sync 与后台 apply 都不会碰 codex
      await sandboxed('unregister-codex', dirs.wfBin, ['agents', 'unregister', 'codex']);
      await sandboxed('status', dirs.wfBin, ['status']);

      started = performance.now();
      // 认证与 gateway 模型别名只来自 settings 源的 env 块，其他字段不复制
      const home = os.homedir();
      let excludes: string[] = [];
      const merged = writeIsolatedSettings(dirs.claudeDir, (settings) => {
        // cwd 在 $HOME 之下时，真实 ~/.claude/CLAUDE.md 会被当作祖先目录的文件读入
        excludes = [path.join(home, '.claude/CLAUDE.md'), path.join(home, '.claude/rules/**')];
        settings.claudeMdExcludes = excludes;
      });
      log.note(
        'merge-settings-env',
        started,
        `合并键 ${merged.join(', ')}；claudeMdExcludes ${excludes.join(', ')}`,
      );
      started = performance.now();
      markOnboardingDone(dirs.claudeDir);
      log.note('mark-onboarding-done', started, path.join(dirs.claudeDir, '.claude.json'));

      // wf 只从 lock 固定的 ctx 提供 wf-history，隔离目录里没有；改由 --mcp-config 直接启动真实 ctx
      fs.writeFileSync(
        dirs.mcpConfig,
        `${JSON.stringify(
          {
            mcpServers: {
              'wf-history': { type: 'stdio', command: ctxBin, args: ['mcp', 'serve'] },
            },
          },
          null,
          2,
        )}\n`,
      );
      fs.writeFileSync(
        dirs.manifest,
        `${JSON.stringify(
          {
            id,
            commit: row.baseCommit,
            skillsSha256: hash,
            version,
            runtime,
            timings: log.timings,
          },
          null,
          2,
        )}\n`,
      );
      log.append(`\n=== 构建完成 ${version} ===\n`);

      db.update(variants)
        .set({
          skillsHash: hash,
          version,
          buildStatus: 'built',
          builtHash: hash,
          builtAt: new Date(),
          buildError: null,
        })
        .where(eq(variants.id, id))
        .run();
      events.publish({ type: 'variant.build', variantId: id, status: 'built', step: null });
      return get(id);
    },

    // 供 runs 调用：首次被运行时冻结，此后 skills、模型与 effort 都不能再改，dist 也不再改写
    freeze(id: string): Variant {
      const row = get(id);
      if (row.status === 'frozen') return row;
      if (row.buildStatus !== 'built' || row.builtHash !== row.skillsHash) {
        throw new HttpError(409, `variant ${row.name} 还没有按当前内容构建，不能冻结`);
      }
      db.update(variants)
        .set({ status: 'frozen', frozenAt: new Date() })
        .where(eq(variants.id, id))
        .run();
      return get(id);
    },

    // runs 每次启动 claude 前调用：重新合并 settings 源当前的 env 块（token 与模型名会变），
    // 并把 Codex 登录凭据与模型配置写进 variant 的 CODEX_HOME（skill 中的 codex exec 用它）；
    // 认证不属于 variant 的内容标识，不影响冻结与 hash
    refreshAuthEnv(id: string): string[] {
      const row = get(id);
      if (row.buildStatus !== 'built') {
        throw new HttpError(409, `variant ${row.name} 还没有构建，没有 settings.json`);
      }
      const dirs = layout.variant(id);
      const merged = writeIsolatedSettings(dirs.claudeDir);
      // 这一步之前构建的 variant 在这里补写一次
      markOnboardingDone(dirs.claudeDir);
      writeCodexHome(dirs.codexHome, { authPath: codexAuthPath, configPath: codexConfigPath });
      return merged;
    },

    runtimeEnv(id: string): RuntimeEnv {
      const row = get(id);
      if (row.buildStatus !== 'built' || row.builtHash !== row.skillsHash) {
        throw new HttpError(409, `variant ${row.name} 还没有按当前内容构建`);
      }
      const dirs = layout.variant(id);
      return {
        env: {
          ...isolatedBaseEnv(),
          CLAUDE_CONFIG_DIR: dirs.claudeDir,
          WF_HOME: dirs.wfHome,
          CODEX_HOME: dirs.codexHome,
          TMPDIR: dirs.tmp,
          // skill 在终端里运行的 wf 要落到 variant 自己的二进制
          PATH: `${path.dirname(dirs.wfBin)}:${z.string().parse(process.env.PATH)}`,
        },
        mcpConfigPath: dirs.mcpConfig,
        // --model 与 --effort 在运行时选（Contracts 16.5），由调用方加在前面
        claudeArgs: ['--mcp-config', dirs.mcpConfig],
        sessionsDir: path.join(dirs.claudeDir, 'projects'),
      };
    },

    // 一个 run 的 claude 进程的 sandbox（Contracts 7.3）；runsDir 是 runs 模块存放各 run 的目录，
    // localRepo 是本地仓库模式下这个 run 的 bare 仓库（GitHub 时为 null）
    sandboxProfile(id: string, runId: string, runsDir: string, localRepo: string | null): string {
      return claudeSandboxProfile(
        runId,
        id,
        {
          repoRoot: config.repoRoot,
          dataDir,
          runsDir,
          variantsDir: path.dirname(layout.variant(id).dir),
          featuresDir: path.join(config.vaultDir, `Project ${config.evalProduct}`, 'Features'),
          home: os.homedir(),
        },
        localRepo,
      );
    },
  };
}

export type Variants = ReturnType<typeof createVariants>;
