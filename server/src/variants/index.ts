import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse, patch } from '@decimalturn/toml-patch';
import { createTwoFilesPatch } from 'diff';
import { desc, eq } from 'drizzle-orm';
import { execa } from 'execa';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { variants } from '../db/schema.js';
import { claudeSettingsEnv } from '../llm/client.js';
import { BuildLog } from './build-log.js';
import { HttpError } from './errors.js';
import type { PublishVariantEvent } from './events.js';
import { dataLayout, type VariantLayout } from './layout.js';
import type { Effort, ModelAlias } from './models.js';
import { claudeSandboxProfile, wfSandboxProfile } from './sandbox.js';
import { listSkillFiles, resolveSkillPath, skillsHash } from './skills.js';

export type Variant = typeof variants.$inferSelect;

export interface VariantsOptions {
  db: Db;
  dataDir: string;
  // txe-workflow 仓库
  repo: string;
  ctxBin: string;
  publish: PublishVariantEvent;
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
  env: {
    CLAUDE_CONFIG_DIR: string;
    WF_HOME: string;
    CODEX_HOME: string;
    TMPDIR: string;
    PATH: string;
  };
  mcpConfigPath: string;
  // --model、--effort 与 --mcp-config
  claudeArgs: string[];
  sandboxProfile: string;
  // claude 写 session jsonl 的目录，Ingester 的来源
  sessionsDir: string;
}

// loose：patch 需要完整的文档，未声明的键必须原样保留
const CargoManifest = z.looseObject({
  workspace: z.looseObject({ package: z.looseObject({ version: z.string() }) }),
});

const IsolatedSettings = z.looseObject({ env: z.record(z.string(), z.unknown()).optional() });

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

export function createVariants({ db, dataDir, repo, ctxBin, publish }: VariantsOptions) {
  const layout = dataLayout(dataDir);
  const runtimeBuilds = new Map<string, Promise<void>>();

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

  function assertNameFree(name: string) {
    if (db.select().from(variants).where(eq(variants.name, name)).get() !== undefined) {
      throw new HttpError(409, `名称已被使用：${name}`);
    }
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
        publish({ type: 'variant.build', variantId: row.id, status: 'building', step });
      },
      (message) => {
        db.update(variants)
          .set({ buildStatus: 'failed', buildError: message })
          .where(eq(variants.id, row.id))
          .run();
        publish({ type: 'variant.build', variantId: row.id, status: 'failed', step: null });
      },
    );
  }

  function updated(id: string) {
    publish({ type: 'variant.updated', variantId: id });
    return get(id);
  }

  // 编辑后重新计算 hash 与版本号；内容变化后原有构建作废
  function afterEdit(row: Variant): Variant {
    const hash = skillsHash(layout.variant(row.id).src);
    if (hash !== row.skillsHash) {
      db.update(variants)
        .set({ skillsHash: hash, version: versionFor(row.baseCommit, hash), buildStatus: 'none' })
        .where(eq(variants.id, row.id))
        .run();
    }
    return updated(row.id);
  }

  function readTree(srcDir: string): Map<string, string> {
    return new Map(
      listSkillFiles(srcDir).map((file) => [
        file,
        fs.readFileSync(path.join(srcDir, file), 'utf8'),
      ]),
    );
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
      model: ModelAlias;
      effort: Effort;
    }): Promise<Variant> {
      assertNameFree(input.name);
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
          parentId: null,
          baseCommit: commit,
          skillsHash: hash,
          version: versionFor(commit, hash),
          model: input.model,
          effort: input.effort,
          installDir: dirs.dir,
        })
        .run();
      return updated(id);
    },

    // 从任一 variant（含已冻结的）复制出新的 draft
    derive(sourceId: string, input: { name: string }): Variant {
      const source = get(sourceId);
      assertNameFree(input.name);
      const id = randomUUID();
      const dirs = layout.variant(id);
      fs.mkdirSync(dirs.dir, { recursive: true });
      fs.cpSync(layout.variant(source.id).src, dirs.src, {
        recursive: true,
        verbatimSymlinks: true,
      });
      fs.writeFileSync(dirs.buildLog, `=== 从 ${source.name}（${source.id}）派生 ===\n`);
      const hash = skillsHash(dirs.src);
      db.insert(variants)
        .values({
          id,
          name: input.name,
          parentId: source.id,
          baseCommit: source.baseCommit,
          skillsHash: hash,
          version: versionFor(source.baseCommit, hash),
          model: source.model,
          effort: source.effort,
          installDir: dirs.dir,
        })
        .run();
      return updated(id);
    },

    setSettings(
      id: string,
      input: { model?: ModelAlias | undefined; effort?: Effort | undefined },
    ) {
      const row = get(id);
      assertDraft(row);
      db.update(variants)
        .set({ model: input.model ?? row.model, effort: input.effort ?? row.effort })
        .where(eq(variants.id, id))
        .run();
      return updated(id);
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
      const before = readTree(reference);
      const after = readTree(layout.variant(id).src);
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
      return { against: { kind: against, variantId, commit: row.baseCommit }, files };
    },

    buildLog(id: string): string {
      get(id);
      return fs.readFileSync(layout.variant(id).buildLog, 'utf8');
    },

    // 构建并隔离安装；每次从空的 dist 与 home 开始
    async build(id: string): Promise<Variant> {
      const row = get(id);
      assertDraft(row);
      if (row.buildStatus === 'building') throw new HttpError(409, `variant ${row.name} 正在构建`);
      db.update(variants)
        .set({ buildStatus: 'building', buildError: null })
        .where(eq(variants.id, id))
        .run();
      publish({ type: 'variant.build', variantId: id, status: 'building', step: null });

      const dirs = layout.variant(id);
      const log = newLog(row);
      log.append(`\n=== 构建 ${new Date().toISOString()} ===\n`);
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
            ...processEnv(),
            WF_HOME: dirs.wfHome,
            CLAUDE_CONFIG_DIR: dirs.claudeDir,
            // wf install 会把检测到的 codex 登记为由 wf 管理，配置根目录取 CODEX_HOME
            CODEX_HOME: dirs.codexHome,
            TMPDIR: dirs.tmp,
          },
        });

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
      // 认证与 gateway 模型别名只来自真实 settings.json 的 env 块，其他字段不复制
      const settingsPath = path.join(dirs.claudeDir, 'settings.json');
      const settings = IsolatedSettings.parse(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
      const realEnv = claudeSettingsEnv();
      settings.env = { ...settings.env, ...realEnv };
      fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
      log.note('merge-settings-env', started, `合并键 ${Object.keys(realEnv).join(', ')}`);

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
      publish({ type: 'variant.build', variantId: id, status: 'built', step: null });
      return updated(id);
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
      return updated(id);
    },

    runtimeEnv(id: string): RuntimeEnv {
      const row = get(id);
      if (row.buildStatus !== 'built' || row.builtHash !== row.skillsHash) {
        throw new HttpError(409, `variant ${row.name} 还没有按当前内容构建`);
      }
      const dirs = layout.variant(id);
      return {
        env: {
          CLAUDE_CONFIG_DIR: dirs.claudeDir,
          WF_HOME: dirs.wfHome,
          CODEX_HOME: dirs.codexHome,
          TMPDIR: dirs.tmp,
          // skill 在终端里运行的 wf 要落到 variant 自己的二进制
          PATH: `${path.dirname(dirs.wfBin)}:${z.string().parse(process.env.PATH)}`,
        },
        mcpConfigPath: dirs.mcpConfig,
        claudeArgs: ['--model', row.model, '--effort', row.effort, '--mcp-config', dirs.mcpConfig],
        sandboxProfile: claudeSandboxProfile(),
        sessionsDir: path.join(dirs.claudeDir, 'projects'),
      };
    },
  };
}

export type Variants = ReturnType<typeof createVariants>;
