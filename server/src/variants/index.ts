import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, patch } from '@decimalturn/toml-patch';
import { createTwoFilesPatch } from 'diff';
import { and, count, desc, eq, isNotNull } from 'drizzle-orm';
import { execa } from 'execa';
import { z } from 'zod';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import { sessions, variants } from '../db/schema.js';
import { events } from '../events.js';
import { claudeSettingsEnv } from '../llm/client.js';
import { loadWorkflow } from '../workflows/index.js';
import { isWfWorkflow, requiredSkills } from '../workflows/schema.js';
import { BuildLog } from './build-log.js';
import { writeCodexHome } from './codex-home.js';
import { HttpError } from './errors.js';
import { dataLayout, type VariantLayout } from './layout.js';
import { createLocalInstalls } from './local-install.js';
import { claudeSandboxProfile, wfSandboxProfile } from './sandbox.js';
import { REGISTRY_FILES, registerSkills } from './skill-registry.js';
import {
  listSkillFiles,
  renameFrontmatter,
  resolveSkillPath,
  skillDir,
  skillsHash,
  skillsProblem,
  writeSkeleton,
} from './skills.js';

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
  // 安装到本机的目标所在的 home（Contracts 18.6），默认用户的 home；测试传入自己的临时目录
  home?: string | undefined;
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

const ClaudeState = z.looseObject({
  hasCompletedOnboarding: z.boolean().optional(),
  // 按目录记录的状态；信任确认记在 projects[<目录>].hasTrustDialogAccepted（Reports/W39 实测，祖先目录的信任也覆盖子目录）
  projects: z
    .record(z.string(), z.looseObject({ hasTrustDialogAccepted: z.boolean().optional() }))
    .optional(),
});

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
  home = os.homedir(),
}: VariantsOptions) {
  const layout = dataLayout(dataDir);
  const runtimeBuilds = new Map<string, Promise<void>>();
  const installs = createLocalInstalls({ installsDir: path.join(dataDir, 'installs'), home });

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

  // 交互启动与 resume 前把 cwd 记为已信任（Contracts 14.2），Claude Code 不再询问；已信任时不改动文件。
  // cwd 经过符号链接时，原路径与真实路径都记上
  function trustDirectory(claudeDir: string, cwd: string) {
    const file = path.join(claudeDir, '.claude.json');
    const state = ClaudeState.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    const dirs = [...new Set([path.resolve(cwd), fs.realpathSync(cwd)])];
    const projects = { ...state.projects };
    if (dirs.every((d) => projects[d]?.hasTrustDialogAccepted === true)) return;
    for (const d of dirs) projects[d] = { ...projects[d], hasTrustDialogAccepted: true };
    const tmp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ ...state, projects }, null, 2)}\n`, { mode: 0o600 });
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

  // variant 的目录：data/variants/<storage_id>，storage_id 为空时是自己的 id
  const storageOf = (row: Pick<Variant, 'id' | 'storageId'>) => row.storageId ?? row.id;
  const dirsOf = (row: Pick<Variant, 'id' | 'storageId'>) => layout.variant(storageOf(row));

  // 编辑或构建前调用（Contracts 16.4）：与其他 variant 共用目录时复制出自己的一份。只复制 src/ 与构建日志，
  // 构建产物与隔离 home 留给共用的另一个 variant，这一个需要重新构建
  function ownStorage(row: Variant): Variant {
    const storage = storageOf(row);
    const sharing = db
      .select({ id: variants.id, storageId: variants.storageId })
      .from(variants)
      .all()
      .filter((v) => v.id !== row.id && storageOf(v) === storage);
    if (sharing.length === 0) return row;
    // 目录名优先取自己的 id；自己的 id 就是共用的目录时另取一个
    const own = fs.existsSync(layout.variant(row.id).dir) ? randomUUID() : row.id;
    const from = layout.variant(storage);
    const to = layout.variant(own);
    fs.mkdirSync(to.dir, { recursive: true });
    fs.cpSync(from.src, to.src, { recursive: true, verbatimSymlinks: true });
    if (fs.existsSync(from.buildLog)) fs.copyFileSync(from.buildLog, to.buildLog);
    fs.appendFileSync(
      to.buildLog,
      `\n=== 不再与 ${sharing.map((v) => v.id).join('、')} 共用目录：复制出自己的 src（${to.dir}），需要重新构建 ===\n`,
    );
    db.update(variants)
      .set({
        storageId: own === row.id ? null : own,
        installDir: to.dir,
        buildStatus: 'none',
        builtHash: null,
        builtAt: null,
        buildError: null,
      })
      .where(eq(variants.id, row.id))
      .run();
    return get(row.id);
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

  // source 的完整 src 复制到 dest 时依次复制的目录（每一层先删去目标再复制）：
  // 导入的 variant 只有 src/skills，由基线导出加上它的 skills 组成
  function sourceLayers(source: Variant, dest: string): { from: string; to: string }[] {
    if (source.installDir !== null) return [{ from: dirsOf(source).src, to: dest }];
    const base = layout.base(source.baseCommit);
    if (!fs.existsSync(base)) {
      throw new HttpError(409, `基线 ${source.baseCommit} 的导出不存在：${base}`);
    }
    return [
      { from: base, to: dest },
      { from: dirsOf(source).skills, to: path.join(dest, 'skills') },
    ];
  }
  const cpOptions = { recursive: true, verbatimSymlinks: true } as const;

  function copySourceTree(source: Variant, dest: string) {
    for (const { from, to } of sourceLayers(source, dest)) {
      fs.rmSync(to, { recursive: true, force: true });
      fs.cpSync(from, to, cpOptions);
    }
  }

  // 新 variant 的 src
  function copySource(source: Variant, id: string) {
    const dirs = layout.variant(id);
    fs.mkdirSync(dirs.dir, { recursive: true });
    copySourceTree(source, dirs.src);
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

  // 内置 lfg、ic 的 variant 版本号取基线的 workspace 版本；任意 workflow 的 variant 没有基线（Contracts 18.6）
  function versionFor(commit: string, hash: string): string {
    if (commit === '') return `skills.${hash.slice(0, 8)}`;
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
      dirsOf(row).buildLog,
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
    const hash = skillsHash(dirsOf(row).src);
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

  // beforeDir 为空：没有可比的一侧，afterDir 中的文件都是新增
  function diffTrees(beforeDir: string | null, afterDir: string): FileDiff[] {
    const before = beforeDir === null ? new Map<string, string>() : readTree(beforeDir);
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

  // 内置 lfg、ic 的 variant：完整的 txe-workflow 导出，用 wf 构建并隔离安装；返回所用 wf runtime 的路径
  async function buildWithWf(
    row: Variant,
    dirs: VariantLayout,
    log: BuildLog,
    hash: string,
    version: string,
  ): Promise<string> {
    await ensureRuntime(row.baseCommit, log);
    const runtime = layout.runtimeBin(row.baseCommit);

    let started = performance.now();
    for (const dir of [dirs.dist, dirs.home, dirs.tmp]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    for (const dir of [path.dirname(dirs.wfBin), dirs.claudeDir, dirs.codexHome, dirs.tmp]) {
      fs.mkdirSync(dir, { recursive: true });
    }
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
    return runtime;
  }

  // 任意 workflow 的 variant（Contracts 18.6）：只有一组 skill，不用 wf。校验 frontmatter 后清空 variant 自己的
  // 配置目录，复制 src/skills 进去；认证与设置之后照常合并
  function buildOwn(row: Variant, dirs: VariantLayout, log: BuildLog) {
    let started = performance.now();
    const problem = skillsProblem(dirs.skills);
    if (problem !== null) log.fail('check-frontmatter', problem);
    log.note(
      'check-frontmatter',
      started,
      '每个 SKILL.md 有 name 与 description，name 与目录名相同',
    );

    started = performance.now();
    for (const dir of [dirs.dist, dirs.home, dirs.tmp]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    for (const dir of [dirs.claudeDir, dirs.codexHome, dirs.tmp]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const installed = path.join(dirs.claudeDir, 'skills');
    fs.cpSync(dirs.skills, installed, { recursive: true, verbatimSymlinks: true });
    const names = fs
      .readdirSync(installed, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    log.note('copy-skills', started, `${dirs.skills} → ${installed}：${names.join('、')}`);

    started = performance.now();
    // 认证与模型别名之后由 writeIsolatedSettings 合并进这份文件（wf 构建时由 wf install 写出）
    fs.writeFileSync(path.join(dirs.claudeDir, 'settings.json'), '{}\n', { mode: 0o600 });
    writeCodexHome(dirs.codexHome, { authPath: codexAuthPath, configPath: codexConfigPath });
    log.note('write-config', started, `${dirs.claudeDir}/settings.json、${dirs.codexHome}`);
    log.append(`\n[own] workflow ${row.workflowId} 的 variant 由 dashboard 管理，没有运行 wf\n`);
  }

  return {
    list(): Variant[] {
      return db.select().from(variants).orderBy(desc(variants.createdAt)).all();
    },

    // 每个 variant 绑定的 session 数（Workflow 页面的 variant 列表，Contracts 16.7）
    boundSessions(): Map<string, number> {
      return new Map(
        db
          .select({ variantId: sessions.variantId, n: count() })
          .from(sessions)
          .where(isNotNull(sessions.variantId))
          .groupBy(sessions.variantId)
          .all()
          .map((r) => [r.variantId ?? '', r.n]),
      );
    },

    get,

    layout(id: string): VariantLayout {
      return dirsOf(get(id));
    },

    async createBaseline(input: {
      name: string;
      commit?: string | undefined;
      // 默认内置的 lfg
      workflowId?: string | undefined;
    }): Promise<Variant> {
      const workflowId = input.workflowId ?? 'lfg';
      loadWorkflow(db, workflowId);
      // txe-workflow 的导出只属于内置的 lfg、ic；任意 workflow 的 variant 只有一组 skill（Contracts 18.6）
      if (!isWfWorkflow(workflowId)) {
        throw new HttpError(
          400,
          `workflow ${workflowId} 不是内置的 lfg 或 ic，不能导入 txe-workflow 的基线；从它已有的 variant 派生`,
        );
      }
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

    // 从空白新建 workflow 时的第一个 variant（Contracts 18.5）：入口与各小阶段的 SKILL.md 骨架，没有基线
    createBlank(input: { workflowId: string; name: string }): Variant {
      const definition = loadWorkflow(db, input.workflowId);
      assertNameFree(input.workflowId, input.name);
      const id = randomUUID();
      const dirs = layout.variant(id);
      writeSkeleton(dirs.skills, definition);
      fs.writeFileSync(
        dirs.buildLog,
        `=== 从空白新建：workflow ${definition.id} 的入口与各小阶段的 SKILL.md 骨架 ===\n`,
      );
      const hash = skillsHash(dirs.src);
      db.insert(variants)
        .values({
          id,
          name: input.name,
          workflowId: input.workflowId,
          parentId: null,
          baseCommit: '',
          skillsHash: hash,
          version: versionFor('', hash),
          installDir: dirs.dir,
        })
        .run();
      onSkillsChanged();
      return get(id);
    },

    // 基本描述（Contracts 18.3）：不属于 skill 内容，已冻结的 variant 也可以改
    setDescription(id: string, description: string): Variant {
      get(id);
      db.update(variants).set({ description: description.trim() }).where(eq(variants.id, id)).run();
      return get(id);
    },

    // Codex 草稿的 src/ 取自底子 variant 的完整 src（Contracts 17.2）
    // 草稿的准备在后台进行：异步复制，lfg、ic 的完整导出较大，复制时服务端照常响应其他请求
    async exportSource(id: string, dest: string) {
      for (const { from, to } of sourceLayers(get(id), dest)) {
        await fs.promises.rm(to, { recursive: true, force: true });
        await fs.promises.cp(from, to, cpOptions);
      }
    },

    // 同一 workflow 中还没有被使用的名字：name，已有时依次加" #2"、" #3"（Contracts 17.4）
    freeName(workflowId: string, name: string): string {
      const taken = new Set(
        db
          .select({ name: variants.name })
          .from(variants)
          .where(eq(variants.workflowId, workflowId))
          .all()
          .map((v) => v.name),
      );
      if (!taken.has(name)) return name;
      for (let n = 2; ; n++) {
        const candidate = `${name} #${String(n)}`;
        if (!taken.has(candidate)) return candidate;
      }
    },

    // 从一份 src/ 建 variant，随后由调用方构建：保存 Codex 草稿（Contracts 17.4、19.3：src/ 取草稿的 src/，
    // parent 为底子 variant，记录来源草稿与分析）与 session-analysis 的基线（19.2：src/ 取仓库中的 skill）
    createFromSource(input: {
      srcDir: string;
      workflowId: string;
      name: string;
      parentId: string | null;
      draftId: string | null;
      analysisId: string | null;
      // 构建日志的第一行
      note: string;
    }): Variant {
      const parent = input.parentId === null ? null : get(input.parentId);
      loadWorkflow(db, input.workflowId);
      assertNameFree(input.workflowId, input.name);
      const id = randomUUID();
      const dirs = layout.variant(id);
      fs.mkdirSync(dirs.dir, { recursive: true });
      fs.cpSync(input.srcDir, dirs.src, { recursive: true, verbatimSymlinks: true });
      fs.writeFileSync(dirs.buildLog, `=== ${input.note} ===\n`);
      const hash = skillsHash(dirs.src);
      const baseCommit = parent?.baseCommit ?? '';
      db.insert(variants)
        .values({
          id,
          name: input.name,
          workflowId: input.workflowId,
          parentId: parent?.id ?? null,
          baseCommit,
          skillsHash: hash,
          version: versionFor(baseCommit, hash),
          installDir: dirs.dir,
          draftId: input.draftId,
          analysisId: input.analysisId,
        })
        .run();
      onSkillsChanged();
      return get(id);
    },

    // 保存草稿时构建失败：删去这次建出、还没有被任何 run 或交互用过的 variant 与它的目录
    removeUnused(id: string) {
      const row = get(id);
      db.delete(variants).where(eq(variants.id, id)).run();
      fs.rmSync(dirsOf(row).dir, { recursive: true, force: true });
      onSkillsChanged();
    },

    listFiles(id: string): SkillFile[] {
      const src = dirsOf(get(id)).src;
      return listSkillFiles(src).map((file) => ({
        path: file,
        size: fs.statSync(path.join(src, file)).size,
      }));
    },

    readFile(id: string, file: string): string {
      const absolute = resolveSkillPath(dirsOf(get(id)).src, file);
      if (!fs.statSync(absolute, { throwIfNoEntry: false })?.isFile()) {
        throw new HttpError(404, `文件不存在：${file}`);
      }
      return fs.readFileSync(absolute, 'utf8');
    },

    // 保存或新建 skills/ 内的文件
    writeFile(id: string, file: string, content: string): Variant {
      const before = get(id);
      assertInstallable(before);
      assertDraft(before);
      const row = ownStorage(before);
      const absolute = resolveSkillPath(dirsOf(row).src, file);
      if (fs.statSync(absolute, { throwIfNoEntry: false })?.isDirectory()) {
        throw new HttpError(400, `路径是目录：${file}`);
      }
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content);
      return afterEdit(row);
    },

    deleteFile(id: string, file: string): Variant {
      const before = get(id);
      assertInstallable(before);
      assertDraft(before);
      const row = ownStorage(before);
      const skillsDir = dirsOf(row).skills;
      const absolute = resolveSkillPath(dirsOf(row).src, file);
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

    // 新增 skill 目录 skills/<name>/，内含只有 frontmatter 的 SKILL.md（Contracts 16.4）
    addSkill(id: string, name: string): Variant {
      const before = get(id);
      assertInstallable(before);
      assertDraft(before);
      const row = ownStorage(before);
      const dir = skillDir(dirsOf(row).skills, name);
      if (fs.existsSync(dir)) throw new HttpError(409, `skill 目录已存在：${name}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${name}\n---\n`,
      );
      return afterEdit(row);
    },

    // 重命名 skill 目录，SKILL.md frontmatter 的 name 随之改为新名字，其余内容不变
    renameSkill(id: string, from: string, to: string): Variant {
      const before = get(id);
      assertInstallable(before);
      assertDraft(before);
      const row = ownStorage(before);
      const skills = dirsOf(row).skills;
      const source = skillDir(skills, from);
      const target = skillDir(skills, to);
      if (!fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
        throw new HttpError(404, `skill 目录不存在：${from}`);
      }
      if (fs.existsSync(target)) throw new HttpError(409, `skill 目录已存在：${to}`);
      fs.renameSync(source, target);
      const skillMd = path.join(target, 'SKILL.md');
      if (fs.existsSync(skillMd)) {
        fs.writeFileSync(skillMd, renameFrontmatter(fs.readFileSync(skillMd, 'utf8'), to));
      }
      return afterEdit(row);
    },

    deleteSkill(id: string, name: string): Variant {
      const before = get(id);
      assertInstallable(before);
      assertDraft(before);
      const row = ownStorage(before);
      const dir = skillDir(dirsOf(row).skills, name);
      if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
        throw new HttpError(404, `skill 目录不存在：${name}`);
      }
      fs.rmSync(dir, { recursive: true });
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
        reference = dirsOf(get(row.parentId)).src;
      } else {
        if (row.baseCommit === '') {
          throw new HttpError(
            400,
            `variant ${row.name} 没有基线（任意 workflow 的 variant 只有一组 skill），只能与来源 variant 对比`,
          );
        }
        reference = layout.base(row.baseCommit);
      }
      return {
        against: { kind: against, variantId, commit: row.baseCommit },
        files: diffTrees(reference, dirsOf(row).src),
      };
    },

    // 任意两个 variant 之间逐文件对比 skills/，from 为旧的一侧
    diffBetween(fromId: string, toId: string): FileDiff[] {
      return diffTrees(dirsOf(get(fromId)).src, dirsOf(get(toId)).src);
    },

    // 一份还没有成为 variant 的 src（Codex 草稿）相对底子 variant 逐文件对比 skills/；没有底子时全部是新增
    diffSource(baseId: string | null, srcDir: string): FileDiff[] {
      return diffTrees(baseId === null ? null : dirsOf(get(baseId)).src, srcDir);
    },

    buildLog(id: string): string {
      return fs.readFileSync(dirsOf(get(id)).buildLog, 'utf8');
    },

    // 构建并隔离安装；每次从空的 dist 与 home 开始
    async build(id: string): Promise<Variant> {
      const before = get(id);
      assertInstallable(before);
      assertDraft(before);
      if (before.buildStatus === 'building') {
        throw new HttpError(409, `variant ${before.name} 正在构建`);
      }
      const row = ownStorage(before);
      db.update(variants)
        .set({ buildStatus: 'building', buildError: null })
        .where(eq(variants.id, id))
        .run();
      events.publish({ type: 'variant.build', variantId: id, status: 'building', step: null });

      const dirs = dirsOf(row);
      const log = newLog(row);
      log.append(`\n=== 构建 ${new Date().toISOString()} ===\n`);
      // 所属 workflow 的入口 skill 与每个小阶段都要有 skill（Contracts 16.1）
      const missing = requiredSkills(loadWorkflow(db, row.workflowId)).filter(
        (name) => !fs.existsSync(path.join(dirs.skills, name, 'SKILL.md')),
      );
      if (missing.length > 0) {
        log.fail(
          'check-skills',
          `variant ${row.name} 缺少 workflow ${row.workflowId} 要求的 skill：${missing.join('、')}（应为 src/skills/<名字>/SKILL.md）`,
        );
      }
      const hash = skillsHash(dirs.src);
      const version = versionFor(row.baseCommit, hash);
      let runtime: string | null = null;
      if (isWfWorkflow(row.workflowId)) {
        runtime = await buildWithWf(row, dirs, log, hash, version);
      } else {
        buildOwn(row, dirs, log);
      }

      let started = performance.now();
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
      const dirs = dirsOf(row);
      const merged = writeIsolatedSettings(dirs.claudeDir);
      // 这一步之前构建的 variant 在这里补写一次
      markOnboardingDone(dirs.claudeDir);
      writeCodexHome(dirs.codexHome, { authPath: codexAuthPath, configPath: codexConfigPath });
      return merged;
    },

    // 安装到本机（Contracts 18.6）：只对任意 workflow 的 variant，装的是按当前内容构建通过的 skill
    installLocal(id: string) {
      const row = get(id);
      if (isWfWorkflow(row.workflowId)) {
        throw new HttpError(
          409,
          `variant ${row.name} 属于内置的 ${row.workflowId}，由 wf 管理，不能由 dashboard 安装到本机`,
        );
      }
      if (row.buildStatus !== 'built' || row.builtHash !== row.skillsHash) {
        throw new HttpError(
          409,
          `variant ${row.name} 还没有按当前内容构建，构建通过后才能安装到本机`,
        );
      }
      return installs.install(row, dirsOf(row).skills);
    },

    uninstallLocal(id: string) {
      get(id);
      return installs.uninstall(id);
    },

    // 装在本机时为安装清单，没有装时为 null
    localInstall(id: string) {
      get(id);
      return installs.status(id);
    },

    // 交互的进程在 cwd 中启动或 resume 前调用（Contracts 14.2）：variant 的配置目录由 dashboard 所有
    trustDirectory(id: string, cwd: string) {
      const row = get(id);
      if (row.buildStatus !== 'built') {
        throw new HttpError(409, `variant ${row.name} 还没有构建，没有 .claude.json`);
      }
      trustDirectory(dirsOf(row).claudeDir, cwd);
    },

    runtimeEnv(id: string): RuntimeEnv {
      const row = get(id);
      if (row.buildStatus !== 'built' || row.builtHash !== row.skillsHash) {
        throw new HttpError(409, `variant ${row.name} 还没有按当前内容构建`);
      }
      const dirs = dirsOf(row);
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
    // localRepo 是本地仓库模式下这个 run 的 bare 仓库（GitHub 时为 null）。放行的是 variant 实际所在的目录
    sandboxProfile(id: string, runId: string, runsDir: string, localRepo: string | null): string {
      const row = get(id);
      return claudeSandboxProfile(
        runId,
        storageOf(row),
        {
          repoRoot: config.repoRoot,
          dataDir,
          runsDir,
          variantsDir: path.dirname(dirsOf(row).dir),
          featuresDir: path.join(config.vaultDir, `Project ${config.evalProduct}`, 'Features'),
          home: os.homedir(),
        },
        localRepo,
      );
    },
  };
}

export type Variants = ReturnType<typeof createVariants>;
