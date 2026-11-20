import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, patch } from '@decimalturn/toml-patch';
import { createTwoFilesPatch } from 'diff';
import { and, asc, count, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { execa } from 'execa';
import { z } from 'zod';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import {
  type LiveEngine,
  liveEngines,
  sessions,
  type VariantEventKind,
  type VariantEventPayload,
  variantEvents,
  variants,
  workflowDrafts,
} from '../db/schema.js';
import { events } from '../events.js';
import { loadWorkflow } from '../workflows/index.js';
import { isWfWorkflow, requiredSkills } from '../workflows/schema.js';
import { BuildLog } from './build-log.js';
import {
  type IsolatedSettings,
  isolatedBaseEnv,
  markOnboardingDone,
  realClaudeMdExcludes,
  trustDirectory,
  writeIsolatedSettings as writeClaudeSettings,
} from './claude-config.js';
import { writeCodexHome } from './codex-home.js';
import { HttpError } from './errors.js';
import { dataLayout, type VariantLayout } from './layout.js';
import { createLocalInstalls, type InstallManifest, type InstallView } from './local-install.js';
import { readMcpServers } from './mcp.js';
import { ORCA_SKILLS, orcaVersion, writeOrcaSkills } from '../orca/skills.js';
import { engineNames } from './names.js';
import { claudeSandboxProfile, localClaudeSandboxProfile, wfSandboxProfile } from './sandbox.js';
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
  // txe-workflow repository
  repo: string;
  ctxBin: string;
  // Source of the gateway auth env, default config.claudeSettingsPath
  claudeSettingsPath?: string | undefined;
  // Source of the Codex login credentials, default config.codexAuthPath
  codexAuthPath?: string | undefined;
  // Source of the Codex model config, default config.codexConfigPath
  codexConfigPath?: string | undefined;
  // Called after a variant is created or its skills change: session auto-binding is re-evaluated (Contracts 15.1)
  onSkillsChanged?: (() => void) | undefined;
  // Home that holds the local machine install targets (Contracts 18.6), default the user's home; tests pass their own temp dir
  home?: string | undefined;
  // orca run when bundling Orca's skills (Contracts 35.5), default config.orca.bin
  orcaBin?: string | undefined;
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
  // Unified diff text
  patch: string;
}

export interface VariantDiff {
  against: { kind: 'parent' | 'base'; variantId: string | null; commit: string };
  files: FileDiff[];
}

// Everything the runner needs to start claude in a variant; the run dir and its parents must have no CLAUDE.md or .claude/
export interface RuntimeEnv {
  // Full child process env: the parent env minus CLAUDE*, ANTHROPIC*, ORCA_AGENT*, plus the variant variables
  env: Record<string, string> & {
    CLAUDE_CONFIG_DIR: string;
    WF_HOME: string;
    CODEX_HOME: string;
    TMPDIR: string;
    PATH: string;
  };
  mcpConfigPath: string;
  // --model, --effort and --mcp-config
  claudeArgs: string[];
  // Dir where claude writes session jsonl, the Ingester's source
  sessionsDir: string;
}

// loose: the patch needs the whole document, undeclared keys must be kept as they are
// The MCP server the dashboard provides in every variant's --mcp-config
const HISTORY_MCP = 'wf-history';

const CargoManifest = z.looseObject({
  workspace: z.looseObject({ package: z.looseObject({ version: z.string() }) }),
});

// One variant history entry (Contracts 16.4, 17.4): the snapshot of an overwrite or restore is the saved previous src/
export const VariantHistoryEntry = z.discriminatedUnion('kind', [
  z.object({
    id: z.number(),
    at: z.number(),
    kind: z.literal('rename'),
    from: z.string(),
    to: z.string(),
  }),
  z.object({
    id: z.number(),
    at: z.number(),
    kind: z.literal('overwrite'),
    snapshot: z.string(),
    draftId: z.string(),
    // Draft engine (Contracts 28.4): recorded on overwrite; older overwrites take the draft's engine, null once the draft is deleted
    draftEngine: z.enum(liveEngines).nullable(),
    analysisId: z.string().nullable(),
  }),
  z.object({
    id: z.number(),
    at: z.number(),
    kind: z.literal('restore'),
    snapshot: z.string(),
    restoredEventId: z.number(),
  }),
]);
export type VariantHistoryEntry = z.infer<typeof VariantHistoryEntry>;

// engineOf: for older overwrites without a recorded engine, looks up the draft's engine by draft id
function historyEntry(
  e: typeof variantEvents.$inferSelect,
  engineOf: (draftId: string) => LiveEngine | null,
): VariantHistoryEntry {
  const payload =
    e.kind === 'overwrite' && 'draftId' in e.payload
      ? { ...e.payload, draftEngine: e.payload.draftEngine ?? engineOf(e.payload.draftId) }
      : e.payload;
  return VariantHistoryEntry.parse({ id: e.id, at: e.at.getTime(), kind: e.kind, ...payload });
}

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
  orcaBin = config.orca.bin,
}: VariantsOptions) {
  const layout = dataLayout(dataDir);
  const runtimeBuilds = new Map<string, Promise<void>>();
  const installs = createLocalInstalls({ installsDir: path.join(dataDir, 'installs'), home });

  // Merges the settings source's env block into the variant's settings.json, other fields kept; returns the merged keys
  const writeIsolatedSettings = (claudeDir: string, edit?: (settings: IsolatedSettings) => void) =>
    writeClaudeSettings(claudeDir, claudeSettingsPath, edit);

  // Variants still building when the server last exited will never finish
  db.update(variants)
    .set({ buildStatus: 'failed', buildError: 'Server restarted, build interrupted' })
    .where(eq(variants.buildStatus, 'building'))
    .run();

  // Includes deleted variants: only for showing names and kept records (Contracts 24.3)
  function record(id: string): Variant {
    const row = db.select().from(variants).where(eq(variants.id, id)).get();
    if (row === undefined) throw new HttpError(404, `Variant not found: ${id}`);
    return row;
  }

  // A deleted variant can no longer be edited, built, run, derived or installed
  function get(id: string): Variant {
    const row = record(id);
    if (row.deletedAt !== null) throw new HttpError(404, `Variant ${row.name} is deleted`);
    return row;
  }

  // Those of these variants installed on the local machine: manifest and files modified after install (Contracts 18.6, 24.4)
  function installsOf(ids: string[]) {
    return ids.flatMap((id) => {
      const manifest = installs.status(id);
      return manifest === null
        ? []
        : [{ variantId: id, manifest, modified: installs.modifiedFiles(id) }];
    });
  }

  // Install manifest view: the variant name is the current one, looked up by id (Contracts 16.4)
  const installView = (manifest: InstallManifest): InstallView => ({
    ...manifest,
    variantName: get(manifest.variantId).name,
  });

  // Variant dir: data/variants/<storage_id>, its own id when storage_id is null
  const storageOf = (row: Pick<Variant, 'id' | 'storageId'>) => row.storageId ?? row.id;
  const dirsOf = (row: Pick<Variant, 'id' | 'storageId'>) => layout.variant(storageOf(row));

  // Called before edit or build (Contracts 16.4): a variant sharing its dir with others gets its own copy. Only src/ and
  // the build log are copied; build output and the isolated home stay with the other variant, this one must rebuild
  function ownStorage(row: Variant): Variant {
    const storage = storageOf(row);
    const sharing = db
      .select({ id: variants.id, storageId: variants.storageId })
      .from(variants)
      .where(isNull(variants.deletedAt))
      .all()
      .filter((v) => v.id !== row.id && storageOf(v) === storage);
    if (sharing.length === 0) return row;
    // The dir name prefers its own id; a new one when its own id is the shared dir
    const own = fs.existsSync(layout.variant(row.id).dir) ? randomUUID() : row.id;
    const from = layout.variant(storage);
    const to = layout.variant(own);
    fs.mkdirSync(to.dir, { recursive: true });
    fs.cpSync(from.src, to.src, { recursive: true, verbatimSymlinks: true });
    if (fs.existsSync(from.buildLog)) fs.copyFileSync(from.buildLog, to.buildLog);
    fs.appendFileSync(
      to.buildLog,
      `\n=== No longer sharing a dir with ${sharing.map((v) => v.id).join(', ')}: copied its own src (${to.dir}), rebuild needed ===\n`,
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
      throw new HttpError(
        409,
        `Variant ${row.name} is frozen; save it as a new variant to change it`,
      );
    }
  }

  // A variant imported from another data dir has only src/skills and no install dir: it cannot be edited, built or run, only derived
  function assertInstallable(row: Variant) {
    if (row.installDir === null) {
      throw new HttpError(
        409,
        `Variant ${row.name} is imported and has only skill content; derive a new variant to edit, build and run it`,
      );
    }
  }

  // Names are unique among the undeleted variants of one workflow (Contracts 16.4, 24.3)
  function assertNameFree(workflowId: string, name: string) {
    const taken = db
      .select()
      .from(variants)
      .where(
        and(
          eq(variants.workflowId, workflowId),
          eq(variants.name, name),
          isNull(variants.deletedAt),
        ),
      )
      .get();
    if (taken !== undefined)
      throw new HttpError(409, `Name already in use: ${name} (${workflowId})`);
  }

  // Rename validation (Contracts 16.4): non-empty after trimming, at most 100 characters
  function checkName(name: string): string {
    const next = name.trim();
    if (next === '') throw new HttpError(400, 'Variant name cannot be empty');
    if (next.length > 100) {
      throw new HttpError(
        400,
        `Variant name is at most 100 characters, got ${String(next.length)}`,
      );
    }
    return next;
  }

  // The description is required when saving a draft or saving an analysis as a variant (Contracts 17.4, 19.3)
  function checkDescription(description: string): string {
    const next = description.trim();
    if (next === '') throw new HttpError(400, 'Variant description cannot be empty');
    if (next.length > 2000) {
      throw new HttpError(
        400,
        `Variant description is at most 2000 characters, got ${String(next.length)}`,
      );
    }
    return next;
  }

  // Overwrite and restore only change editable variants: not imported or frozen ones (Contracts 17.4). null when allowed, else the reason
  function replaceBlocker(row: Variant): string | null {
    if (row.installDir === null)
      return 'Imported variant has only skill content and cannot be overwritten';
    if (row.status === 'frozen') return 'Frozen (used by a batch), content is read-only';
    if (row.buildStatus === 'building')
      return 'Building; it can be overwritten after the build ends';
    return null;
  }

  function assertReplaceable(row: Variant) {
    const reason = replaceBlocker(row);
    if (reason !== null) throw new HttpError(409, `Variant ${row.name}: ${reason}`);
  }

  // Saves the variant's current src/ into history, returns the snapshot dir name
  function snapshotSource(row: Variant): string {
    const snapshot = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
    const dest = layout.historySrc(row.id, snapshot);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(dirsOf(row).src, dest, { recursive: true, verbatimSymlinks: true });
    return snapshot;
  }

  // Replaces the variant's src/ with from: build output removed, status not built (Contracts 17.4)
  function replaceSource(row: Variant, from: string, note: string) {
    const dirs = dirsOf(row);
    fs.rmSync(dirs.src, { recursive: true, force: true });
    fs.cpSync(from, dirs.src, { recursive: true, verbatimSymlinks: true });
    fs.rmSync(dirs.dist, { recursive: true, force: true });
    fs.rmSync(dirs.manifest, { force: true });
    fs.appendFileSync(dirs.buildLog, `\n=== ${note}, build needed ===\n`);
    const hash = skillsHash(dirs.src);
    return {
      skillsHash: hash,
      version: versionFor(row.baseCommit, hash),
      buildStatus: 'none' as const,
      builtHash: null,
      builtAt: null,
      buildError: null,
    };
  }

  function addEvent(variantId: string, kind: VariantEventKind, payload: VariantEventPayload) {
    db.insert(variantEvents).values({ variantId, at: new Date(), kind, payload }).run();
  }

  const draftEngineOf = (draftId: string): LiveEngine | null =>
    db
      .select({ engine: workflowDrafts.engine })
      .from(workflowDrafts)
      .where(eq(workflowDrafts.id, draftId))
      .get()?.engine ?? null;

  // Snapshot dir name recorded by an overwrite or restore in history; renames have no snapshot
  function snapshotOf(variantId: string, eventId: number): string {
    const event = db
      .select()
      .from(variantEvents)
      .where(and(eq(variantEvents.id, eventId), eq(variantEvents.variantId, variantId)))
      .get();
    if (event === undefined) {
      throw new HttpError(404, `Variant ${variantId} history has no #${String(eventId)}`);
    }
    const entry = historyEntry(event, draftEngineOf);
    if (entry.kind === 'rename') {
      throw new HttpError(
        400,
        `History #${String(eventId)} is a rename and has no src to view or restore`,
      );
    }
    return entry.snapshot;
  }

  // Dirs copied in order when copying source's full src to dest (each layer removes the target first):
  // an imported variant has only src/skills, so it is the baseline export plus its skills
  function sourceLayers(source: Variant, dest: string): { from: string; to: string }[] {
    if (source.installDir !== null) return [{ from: dirsOf(source).src, to: dest }];
    const base = layout.base(source.baseCommit);
    if (!fs.existsSync(base)) {
      throw new HttpError(409, `Export of baseline ${source.baseCommit} does not exist: ${base}`);
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

  // src of a new variant
  function copySource(source: Variant, id: string) {
    const dirs = layout.variant(id);
    fs.mkdirSync(dirs.dir, { recursive: true });
    copySourceTree(source, dirs.src);
    return dirs;
  }

  // Copies a new draft from source, belonging to workflowId
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

  // Built-in lfg/ic variants take the baseline's workspace version; variants of any other workflow have no baseline (Contracts 18.6)
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

  // wf is compiled once per baseline commit and shared by its variants. Source is exported to this build's own dir and the
  // compiled wf is renamed into runtimes/<commit>/: processes building the same commit at once (e.g. parallel test files)
  // do not delete each other's files; cargo locks the shared target dir itself
  async function buildRuntime(commit: string, log: BuildLog) {
    const src = path.join(layout.runtimeDir(commit), `src-${randomUUID()}`);
    await exportCommit(commit, src, log);
    // The runtime is compiled with the baseline's own version, so Cargo.lock needs no rewrite
    await log.run('cargo-build', 'cargo', ['build', '--locked', '-p', 'wf-cli'], {
      cwd: src,
      env: { ...processEnv(), CARGO_TARGET_DIR: layout.cargoTarget },
    });
    const partial = `${layout.runtimeBin(commit)}.${randomUUID()}.partial`;
    fs.copyFileSync(path.join(layout.cargoTarget, 'debug', 'wf'), partial);
    fs.renameSync(partial, layout.runtimeBin(commit));
    fs.rmSync(src, { recursive: true });
  }

  async function ensureRuntime(commit: string, log: BuildLog) {
    if (fs.existsSync(layout.runtimeBin(commit))) {
      log.append(`\n[runtime] Reusing ${layout.runtimeBin(commit)}\n`);
      return;
    }
    let pending = runtimeBuilds.get(commit);
    if (pending === undefined) {
      pending = buildRuntime(commit, log).finally(() => runtimeBuilds.delete(commit));
      runtimeBuilds.set(commit, pending);
    } else {
      log.append(`\n[runtime] Waiting for another build compiling wf for ${commit}\n`);
    }
    await pending;
  }

  // The date guard checks against: the base commit's own commit date. An imported or derived variant carries the base commit
  // from its parent; one without a base commit has no date to check against
  async function guardDate(row: Variant, log: BuildLog): Promise<string> {
    if (row.baseCommit === '') {
      log.fail(
        'guard-now',
        `Variant ${row.name} has no base commit, so guard has no date to check`,
      );
    }
    const date = (
      await log.run(
        'guard-now',
        'git',
        ['-C', repo, 'show', '-s', '--format=%cs', row.baseCommit],
        { cwd: repo, env: processEnv() },
      )
    ).trim();
    log.append(`[guard-now] guard as of ${date}, the base commit's date\n`);
    return date;
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

  // Recompute hash and version after an edit; a content change invalidates the existing build
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

  // beforeDir null: nothing to compare against, every file in afterDir is added
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

  // Variants of the built-in lfg, ic: a full txe-workflow export, built and isolated-installed with wf; returns the wf runtime path used
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
    log.note('version', started, `skills sha256 ${hash}, version ${version}`);

    const sandboxed = (step: string, wf: string, args: string[]) =>
      log.run(step, 'sandbox-exec', ['-p', wfSandboxProfile(dirs.dir), wf, ...args], {
        cwd: dirs.src,
        env: {
          ...isolatedBaseEnv(),
          WF_HOME: dirs.wfHome,
          CLAUDE_CONFIG_DIR: dirs.claudeDir,
          // wf install registers a detected codex as wf-managed, with CODEX_HOME as its config root
          CODEX_HOME: dirs.codexHome,
          TMPDIR: dirs.tmp,
        },
      });

    // Added or removed skill dirs are registered in the registry and docs lists (Contracts 16.4); changes go back to src/ and the build log
    started = performance.now();
    const registration = registerSkills(dirs.src);
    log.note(
      'register-skills',
      started,
      registration.added.length === 0 && registration.removed.length === 0
        ? 'No skill added or removed'
        : `Registered ${registration.added.join(', ') || '(none)'}; removed ${registration.removed.join(', ') || '(none)'} (${REGISTRY_FILES.join(', ')})`,
    );
    // Some txe-workflow rules judge by date (CLM-003 wants a claim verified within 60 days), so guard runs as of the base
    // commit's date: the result then depends only on the variant's content, not on the day it is built (Contracts 16.4)
    const guardNow = await guardDate(row, log);
    // Changing a skill frontmatter requires regenerating docs/generated/skills.md
    await sandboxed('guard-fix', runtime, ['guard', '--fix', '--now', guardNow]);
    await sandboxed('guard', runtime, ['guard', '--now', guardNow]);
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
    // A copy-on-write clone on APFS, taking no extra space
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
    // wf manages only the isolated Claude dir; later repair, sync and background apply without --agent never touch codex
    await sandboxed('unregister-codex', dirs.wfBin, ['agents', 'unregister', 'codex']);
    await sandboxed('status', dirs.wfBin, ['status']);
    return runtime;
  }

  // Variant of any workflow (Contracts 18.6): only a set of skills, no wf. After checking frontmatter, empty the variant's own
  // config dir and copy src/skills into it; auth and settings are merged afterwards as usual
  function buildOwn(row: Variant, dirs: VariantLayout, log: BuildLog) {
    let started = performance.now();
    const problem = skillsProblem(dirs.skills);
    if (problem !== null) log.fail('check-frontmatter', problem);
    log.note(
      'check-frontmatter',
      started,
      'Every SKILL.md has name and description, and name matches its directory name',
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
    log.note('copy-skills', started, `${dirs.skills} → ${installed}: ${names.join(', ')}`);

    started = performance.now();
    // Auth and model aliases are merged into this file later by writeIsolatedSettings (wf builds have it written by wf install)
    fs.writeFileSync(path.join(dirs.claudeDir, 'settings.json'), '{}\n', { mode: 0o600 });
    writeCodexHome(dirs.codexHome, { authPath: codexAuthPath, configPath: codexConfigPath });
    log.note('write-config', started, `${dirs.claudeDir}/settings.json, ${dirs.codexHome}`);
    log.append(
      `\n[own] Variant of workflow ${row.workflowId} is managed by the dashboard; wf not run\n`,
    );
  }

  return {
    // Deleted ones are excluded unless includeDeleted (Compare shows kept runs, Contracts 24.3)
    list(includeDeleted = false): Variant[] {
      return db
        .select()
        .from(variants)
        .where(includeDeleted ? undefined : isNull(variants.deletedAt))
        .orderBy(desc(variants.createdAt))
        .all();
    },

    record,

    // Dirs to remove when deleting these variants (Contracts 24.4): each one's dir under data/variants/ (kept while shared with
    // a variant not being deleted, removed with the last one referencing it) and the pre-overwrite archives; only existing ones
    deletionDirs(ids: string[]): string[] {
      const removing = new Set(ids);
      const rows = ids.map(record);
      const others = db
        .select()
        .from(variants)
        .where(isNull(variants.deletedAt))
        .all()
        .filter((v) => !removing.has(v.id));
      const kept = new Set(others.map(storageOf));
      const dirs = new Set<string>();
      for (const row of rows) {
        if (!kept.has(storageOf(row))) dirs.add(dirsOf(row).dir);
        // data/variant-history/<id>/: every src/ saved before an overwrite or restore
        dirs.add(path.dirname(path.dirname(layout.historySrc(row.id, 'x'))));
      }
      return [...dirs].filter((d) => fs.existsSync(d)).sort();
    },

    // Installed on this machine (Contracts 18.6): manifests and files changed after install
    installsOf,

    // The file part of deletion: uninstall from this machine first (409 with the original text if changed), then remove deletionDirs
    removeFiles(ids: string[], dirs: string[]) {
      for (const { variantId } of installsOf(ids)) installs.uninstall(variantId);
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    },

    // Mark deleted in the database (inside the caller's transaction): only name and workflow are kept for display
    markDeleted(ids: string[], at: Date) {
      if (ids.length === 0) return;
      db.update(variants)
        .set({ deletedAt: at, buildStatus: 'none', builtHash: null, builtAt: null })
        .where(inArray(variants.id, ids))
        .run();
    },

    // Number of sessions bound to each variant (variant list on the Workflow page, Contracts 16.7)
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
      // Defaults to the built-in lfg
      workflowId?: string | undefined;
      // Description and tag recorded when a txe-workflow release is auto-imported (Contracts 29.1)
      description?: string | undefined;
      releaseTag?: string | undefined;
    }): Promise<Variant> {
      const workflowId = input.workflowId ?? 'lfg';
      loadWorkflow(db, workflowId);
      // txe-workflow exports belong only to the built-in lfg, ic; a variant of any workflow is just a set of skills (Contracts 18.6)
      if (!isWfWorkflow(workflowId)) {
        throw new HttpError(
          400,
          `Workflow ${workflowId} is not the built-in lfg or ic and cannot import a txe-workflow baseline; derive from one of its existing variants`,
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
      log.append(`=== Exporting baseline ${commit} ${new Date().toISOString()} ===\n`);
      if (!fs.existsSync(layout.base(commit))) await exportCommit(commit, layout.base(commit), log);
      await exportCommit(commit, dirs.src, log);
      const hash = skillsHash(dirs.src);
      db.insert(variants)
        .values({
          id,
          name: input.name,
          description: input.description ?? null,
          workflowId,
          parentId: null,
          baseCommit: commit,
          skillsHash: hash,
          version: versionFor(commit, hash),
          installDir: dirs.dir,
          releaseTag: input.releaseTag ?? null,
        })
        .run();
      onSkillsChanged();
      return get(id);
    },

    // Copy a new draft from any variant (frozen ones too), only within the same workflow (Contracts 16.4). An imported variant
    // has only src/skills: the new src is the baseline export plus its skills, with the same skills hash until edited
    derive(sourceId: string, input: { name: string; workflowId?: string | undefined }): Variant {
      const source = get(sourceId);
      if (input.workflowId !== undefined && input.workflowId !== source.workflowId) {
        throw new HttpError(
          400,
          `Variant ${source.name} belongs to workflow ${source.workflowId} and cannot be derived into ${input.workflowId}: deriving only works within the same workflow; create a new workflow to go across`,
        );
      }
      return copyVariant(source, {
        name: input.name,
        workflowId: source.workflowId,
        note: `Derived from ${source.name} (${source.id})`,
      });
    },

    // The first variant of a workflow created from blank (Contracts 18.5): SKILL.md skeletons for the entry and each sub-stage, no baseline
    createBlank(input: { workflowId: string; name: string }): Variant {
      const definition = loadWorkflow(db, input.workflowId);
      assertNameFree(input.workflowId, input.name);
      const id = randomUUID();
      const dirs = layout.variant(id);
      writeSkeleton(dirs.skills, definition);
      fs.writeFileSync(
        dirs.buildLog,
        `=== Created from blank: SKILL.md skeletons for the entry and sub-stages of workflow ${definition.id} ===\n`,
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

    // Basic description (Contracts 18.3): not skill content, so frozen variants can change it too
    setDescription(id: string, description: string): Variant {
      get(id);
      db.update(variants).set({ description: description.trim() }).where(eq(variants.id, id)).run();
      return get(id);
    },

    // "Include Orca skills" (Contracts 35.5): changes installed content, so only drafts can change it; a rebuild is needed after
    setOrcaSkills(id: string, on: boolean): Variant {
      const row = get(id);
      assertDraft(row);
      if (row.orcaSkills === on) return row;
      db.update(variants).set({ orcaSkills: on, builtHash: null }).where(eq(variants.id, id)).run();
      events.publish({ type: 'variant.updated', variantId: id });
      return get(id);
    },

    // Orca version on this machine; empty without an orca command
    orcaVersion: () => orcaVersion(orcaBin),

    // Rename (Contracts 16.4): any variant, including imported, frozen and built-in workflow baselines;
    // everything else looks names up by id, so this one change applies everywhere. History records old, new name and time; pages refresh via variant.updated
    rename(id: string, name: string): Variant {
      const row = get(id);
      const next = checkName(name);
      if (next === row.name) return row;
      assertNameFree(row.workflowId, next);
      db.$client.transaction(() => {
        db.update(variants).set({ name: next }).where(eq(variants.id, id)).run();
        addEvent(id, 'rename', { from: row.name, to: next });
      })();
      events.publish({ type: 'variant.updated', variantId: id });
      return get(id);
    },

    // A Codex draft's src/ comes from the full src of its base variant (Contracts 17.2)
    // Draft preparation runs in the background: async copy, since full lfg, ic exports are large and the server keeps serving meanwhile
    async exportSource(id: string, dest: string) {
      for (const { from, to } of sourceLayers(get(id), dest)) {
        await fs.promises.rm(to, { recursive: true, force: true });
        await fs.promises.cp(from, to, cpOptions);
      }
    },

    // A name not yet used in the workflow: name, or with " #2", " #3" appended in turn when taken (Contracts 17.4)
    freeName(workflowId: string, name: string): string {
      const taken = new Set(
        db
          .select({ name: variants.name })
          .from(variants)
          .where(and(eq(variants.workflowId, workflowId), isNull(variants.deletedAt)))
          .all()
          .map((v) => v.name),
      );
      if (!taken.has(name)) return name;
      for (let n = 2; ; n++) {
        const candidate = `${name} #${String(n)}`;
        if (!taken.has(candidate)) return candidate;
      }
    },

    // Create an unbuilt variant from a src/: saving Codex drafts and analysis optimizations (Contracts 17.4, 19.3: src/ is the draft's
    // src/, parent is the base variant, source draft and analysis recorded) and session-analysis baselines (19.2: src/ is the repo's skills)
    createFromSource(input: {
      srcDir: string;
      workflowId: string;
      name: string;
      description: string | null;
      parentId: string | null;
      draftId: string | null;
      analysisId: string | null;
      // First line of the build log
      note: string;
    }): Variant {
      // parent may be a deleted variant (a draft's base keeps its id, Contracts 24.3): only its baseline commit is used
      const parent = input.parentId === null ? null : record(input.parentId);
      loadWorkflow(db, input.workflowId);
      const name = checkName(input.name);
      const description = input.description === null ? null : checkDescription(input.description);
      assertNameFree(input.workflowId, name);
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
          name,
          description,
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

    // Overwrite an existing variant (Contracts 17.4): the old src/ goes to history first, then is replaced by the draft's src/; name and
    // description are updated too, status becomes unbuilt, source draft and analysis recorded, parent unchanged. Imported and frozen ones cannot be overwritten
    overwriteFromSource(
      id: string,
      input: {
        srcDir: string;
        name: string;
        description: string;
        draftId: string;
        draftEngine: LiveEngine;
        analysisId: string | null;
      },
    ): Variant {
      const before = get(id);
      assertReplaceable(before);
      const name = checkName(input.name);
      const description = checkDescription(input.description);
      if (name !== before.name) assertNameFree(before.workflowId, name);
      const row = ownStorage(before);
      const snapshot = snapshotSource(row);
      const build = replaceSource(
        row,
        input.srcDir,
        `Overwrote src with ${engineNames[input.draftEngine]} draft ${input.draftId} (previous src saved to history ${snapshot})`,
      );
      db.$client.transaction(() => {
        db.update(variants)
          .set({
            ...build,
            name,
            description,
            draftId: input.draftId,
            analysisId: input.analysisId,
          })
          .where(eq(variants.id, id))
          .run();
        if (name !== before.name) addEvent(id, 'rename', { from: before.name, to: name });
        addEvent(id, 'overwrite', {
          snapshot,
          draftId: input.draftId,
          draftEngine: input.draftEngine,
          analysisId: input.analysisId,
        });
      })();
      onSkillsChanged();
      events.publish({ type: 'variant.updated', variantId: id });
      return get(id);
    },

    // Restore a src/ from history (Contracts 17.4): the current src/ is saved to history first, so a restore can be undone
    restore(id: string, eventId: number): Variant {
      const before = get(id);
      assertReplaceable(before);
      const from = layout.historySrc(id, snapshotOf(id, eventId));
      const row = ownStorage(before);
      const snapshot = snapshotSource(row);
      const build = replaceSource(
        row,
        from,
        `Restored src from history #${String(eventId)} (src before the restore saved to history ${snapshot})`,
      );
      db.$client.transaction(() => {
        db.update(variants).set(build).where(eq(variants.id, id)).run();
        addEvent(id, 'restore', { snapshot, restoredEventId: eventId });
      })();
      onSkillsChanged();
      events.publish({ type: 'variant.updated', variantId: id });
      return get(id);
    },

    // View a src/ from history: per-file changes if the current content were restored to it
    historyDiff(id: string, eventId: number): FileDiff[] {
      return diffTrees(dirsOf(get(id)).src, layout.historySrc(id, snapshotOf(id, eventId)));
    },

    // A variant's history in time order: renames, overwrites and restores
    history(id: string): VariantHistoryEntry[] {
      get(id);
      return db
        .select()
        .from(variantEvents)
        .where(eq(variantEvents.variantId, id))
        .orderBy(asc(variantEvents.id))
        .all()
        .map((e) => historyEntry(e, draftEngineOf));
    },

    checkName,
    checkDescription,
    replaceBlocker,

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
        throw new HttpError(404, `File not found: ${file}`);
      }
      return fs.readFileSync(absolute, 'utf8');
    },

    // Save or create a file inside skills/
    writeFile(id: string, file: string, content: string): Variant {
      const before = get(id);
      assertInstallable(before);
      assertDraft(before);
      const row = ownStorage(before);
      const absolute = resolveSkillPath(dirsOf(row).src, file);
      if (fs.statSync(absolute, { throwIfNoEntry: false })?.isDirectory()) {
        throw new HttpError(400, `Path is a directory: ${file}`);
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
        throw new HttpError(404, `File not found: ${file}`);
      }
      fs.rmSync(absolute);
      // Remove parent dirs left empty, up to skills/
      for (let dir = path.dirname(absolute); dir !== skillsDir; dir = path.dirname(dir)) {
        if (fs.readdirSync(dir).length > 0) break;
        fs.rmdirSync(dir);
      }
      return afterEdit(row);
    },

    // Add a skill dir skills/<name>/ holding a SKILL.md with only frontmatter (Contracts 16.4)
    addSkill(id: string, name: string): Variant {
      const before = get(id);
      assertInstallable(before);
      assertDraft(before);
      const row = ownStorage(before);
      const dir = skillDir(dirsOf(row).skills, name);
      if (fs.existsSync(dir)) throw new HttpError(409, `Skill directory already exists: ${name}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${name}\n---\n`,
      );
      return afterEdit(row);
    },

    // Rename a skill dir; the SKILL.md frontmatter name changes to the new name, the rest is unchanged
    renameSkill(id: string, from: string, to: string): Variant {
      const before = get(id);
      assertInstallable(before);
      assertDraft(before);
      const row = ownStorage(before);
      const skills = dirsOf(row).skills;
      const source = skillDir(skills, from);
      const target = skillDir(skills, to);
      if (!fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
        throw new HttpError(404, `Skill directory not found: ${from}`);
      }
      if (fs.existsSync(target)) throw new HttpError(409, `Skill directory already exists: ${to}`);
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
        throw new HttpError(404, `Skill directory not found: ${name}`);
      }
      fs.rmSync(dir, { recursive: true });
      return afterEdit(row);
    },

    // Per-file diff of skills/ against the parent or the baseline commit
    diff(id: string, against: 'parent' | 'base'): VariantDiff {
      const row = get(id);
      let reference: string;
      let variantId: string | null = null;
      if (against === 'parent') {
        if (row.parentId === null) throw new HttpError(400, `Variant ${row.name} has no parent`);
        variantId = row.parentId;
        reference = dirsOf(get(row.parentId)).src;
      } else {
        if (row.baseCommit === '') {
          throw new HttpError(
            400,
            `Variant ${row.name} has no baseline (a variant of any workflow is only a set of skills); it can only be compared with its source variant`,
          );
        }
        reference = layout.base(row.baseCommit);
      }
      return {
        against: { kind: against, variantId, commit: row.baseCommit },
        files: diffTrees(reference, dirsOf(row).src),
      };
    },

    // Per-file diff of skills/ between any two variants; from is the older side
    diffBetween(fromId: string, toId: string): FileDiff[] {
      return diffTrees(dirsOf(get(fromId)).src, dirsOf(get(toId)).src);
    },

    // Per-file diff of skills/ of a src not yet a variant (Codex draft) against its base variant; all added when there is no base
    diffSource(baseId: string | null, srcDir: string): FileDiff[] {
      return diffTrees(baseId === null ? null : dirsOf(get(baseId)).src, srcDir);
    },

    buildLog(id: string): string {
      return fs.readFileSync(dirsOf(get(id)).buildLog, 'utf8');
    },

    // Build and isolated-install; always starts from empty dist and home
    async build(id: string): Promise<Variant> {
      const before = get(id);
      assertInstallable(before);
      assertDraft(before);
      if (before.buildStatus === 'building') {
        throw new HttpError(409, `Variant ${before.name} is already building`);
      }
      const row = ownStorage(before);
      db.update(variants)
        .set({ buildStatus: 'building', buildError: null })
        .where(eq(variants.id, id))
        .run();
      events.publish({ type: 'variant.build', variantId: id, status: 'building', step: null });

      const dirs = dirsOf(row);
      const log = newLog(row);
      log.append(`\n=== Build ${new Date().toISOString()} ===\n`);
      // The workflow's entry and each sub-stage need a skill (Contracts 16.1)
      const missing = requiredSkills(loadWorkflow(db, row.workflowId)).filter(
        (name) => !fs.existsSync(path.join(dirs.skills, name, 'SKILL.md')),
      );
      if (missing.length > 0) {
        log.fail(
          'check-skills',
          `Variant ${row.name} is missing skills required by workflow ${row.workflowId}: ${missing.join(', ')} (expected src/skills/<name>/SKILL.md)`,
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
      // Include Orca skills (Contracts 35.5): put into the config dir's skills/, recording the Orca version
      let orcaSkillsVersion: string | null = null;
      if (row.orcaSkills) {
        const skillsDir = path.join(dirs.claudeDir, 'skills');
        orcaSkillsVersion = await writeOrcaSkills(orcaBin, skillsDir);
        log.note(
          'orca-skills',
          started,
          `Orca ${orcaSkillsVersion}: ${ORCA_SKILLS.join(', ')} → ${skillsDir}`,
        );
      }

      started = performance.now();
      // Auth and gateway model aliases come only from the settings source's env block; other fields are not copied
      const excludes = realClaudeMdExcludes();
      const merged = writeIsolatedSettings(dirs.claudeDir, (settings) => {
        settings.claudeMdExcludes = excludes;
      });
      log.note(
        'merge-settings-env',
        started,
        `Merged keys ${merged.join(', ')}; claudeMdExcludes ${excludes.join(', ')}`,
      );
      started = performance.now();
      markOnboardingDone(dirs.claudeDir);
      log.note('mark-onboarding-done', started, path.join(dirs.claudeDir, '.claude.json'));

      // wf provides wf-history only from the lock-pinned ctx, absent from the isolated dir; --mcp-config starts the real ctx instead.
      // A variant of any workflow adds the servers in src/mcp.json (Contracts 28.1); Live and runs load them via --mcp-config
      started = performance.now();
      const own = isWfWorkflow(row.workflowId) ? {} : readMcpServers(dirs.src);
      if (HISTORY_MCP in own) {
        log.fail(
          'write-mcp-config',
          `${HISTORY_MCP} in src/mcp.json has the same name as the one the dashboard provides; rename it`,
        );
      }
      fs.writeFileSync(
        dirs.mcpConfig,
        `${JSON.stringify(
          {
            mcpServers: {
              [HISTORY_MCP]: { type: 'stdio', command: ctxBin, args: ['mcp', 'serve'] },
              ...own,
            },
          },
          null,
          2,
        )}\n`,
      );
      log.note(
        'write-mcp-config',
        started,
        `${dirs.mcpConfig}: ${[HISTORY_MCP, ...Object.keys(own)].join(', ')}`,
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
      log.append(`\n=== Build complete ${version} ===\n`);

      db.update(variants)
        .set({
          skillsHash: hash,
          version,
          buildStatus: 'built',
          builtHash: hash,
          builtAt: new Date(),
          buildError: null,
          orcaVersion: orcaSkillsVersion,
        })
        .where(eq(variants.id, id))
        .run();
      events.publish({ type: 'variant.build', variantId: id, status: 'built', step: null });
      return get(id);
    },

    // Called by runs: frozen on first run; afterwards skills, model and effort can no longer change and dist is not rewritten
    freeze(id: string): Variant {
      const row = get(id);
      if (row.status === 'frozen') return row;
      if (row.buildStatus !== 'built' || row.builtHash !== row.skillsHash) {
        throw new HttpError(
          409,
          `Variant ${row.name} is not built from its current content and cannot be frozen`,
        );
      }
      db.update(variants)
        .set({ status: 'frozen', frozenAt: new Date() })
        .where(eq(variants.id, id))
        .run();
      return get(id);
    },

    // Called by runs before each claude start: re-merge the settings source's current env block (tokens and model names change),
    // and write Codex login credentials and model config into the variant's CODEX_HOME (used by codex exec in skills);
    // auth is not part of the variant's content identity and affects neither freezing nor hash
    refreshAuthEnv(id: string): string[] {
      const row = get(id);
      if (row.buildStatus !== 'built') {
        throw new HttpError(409, `Variant ${row.name} is not built yet and has no settings.json`);
      }
      const dirs = dirsOf(row);
      const merged = writeIsolatedSettings(dirs.claudeDir);
      // Variants built before this step existed get it written here once
      markOnboardingDone(dirs.claudeDir);
      writeCodexHome(dirs.codexHome, { authPath: codexAuthPath, configPath: codexConfigPath });
      return merged;
    },

    // Install on this machine (Contracts 18.6): only for variants of any workflow; installs the skills built from the current content
    installLocal(id: string) {
      const row = get(id);
      if (isWfWorkflow(row.workflowId)) {
        throw new HttpError(
          409,
          `Variant ${row.name} belongs to the built-in ${row.workflowId}, which wf manages; the dashboard cannot install it on this machine`,
        );
      }
      if (row.buildStatus !== 'built' || row.builtHash !== row.skillsHash) {
        throw new HttpError(
          409,
          `Variant ${row.name} is not built from its current content; it can be installed on this machine once a build passes`,
        );
      }
      const { manifest, replaced } = installs.install(row, dirsOf(row).skills);
      return { manifest: installView(manifest), replaced: replaced.map(installView) };
    },

    uninstallLocal(id: string) {
      get(id);
      return installView(installs.uninstall(id));
    },

    // The install manifest when installed on this machine, null otherwise
    localInstall(id: string) {
      get(id);
      const manifest = installs.status(id);
      return manifest === null ? null : installView(manifest);
    },

    // Called before an interactive process starts or resumes in cwd (Contracts 14.2): the dashboard owns the variant's config dir
    trustDirectory(id: string, cwd: string, realCwd: string) {
      const row = get(id);
      if (row.buildStatus !== 'built') {
        throw new HttpError(409, `Variant ${row.name} is not built yet and has no .claude.json`);
      }
      trustDirectory(dirsOf(row).claudeDir, cwd, realCwd);
    },

    runtimeEnv(id: string): RuntimeEnv {
      const row = get(id);
      if (row.buildStatus !== 'built' || row.builtHash !== row.skillsHash) {
        throw new HttpError(409, `Variant ${row.name} is not built from its current content`);
      }
      const dirs = dirsOf(row);
      return {
        env: {
          ...isolatedBaseEnv(),
          CLAUDE_CONFIG_DIR: dirs.claudeDir,
          WF_HOME: dirs.wfHome,
          CODEX_HOME: dirs.codexHome,
          TMPDIR: dirs.tmp,
          // wf run by a skill in the terminal must resolve to the variant's own binary
          PATH: `${path.dirname(dirs.wfBin)}:${z.string().parse(process.env.PATH)}`,
        },
        mcpConfigPath: dirs.mcpConfig,
        // --model and --effort are chosen at run time (Contracts 16.5) and prepended by the caller
        claudeArgs: ['--mcp-config', dirs.mcpConfig],
        sessionsDir: path.join(dirs.claudeDir, 'projects'),
      };
    },

    // The sandbox of a run's claude process (Contracts 7.3); runsDir is where the runs module keeps each run.
    // Allowed is the variant's actual directory
    sandboxProfile(id: string, runId: string, runsDir: string): string {
      const row = get(id);
      return claudeSandboxProfile(runId, storageOf(row), {
        repoRoot: config.repoRoot,
        dataDir,
        runsDir,
        variantsDir: path.dirname(dirsOf(row).dir),
        featuresDir: path.join(config.vaultDir, `Project ${config.evalProduct}`, 'Features'),
        home: os.homedir(),
      });
    },

    // The sandbox of an interactive process with the local configuration in the isolated environment (Contracts 29.2):
    // .claude, .claude.json and wf's state directory under claudeHome are readable and writable
    localSandboxProfile(runId: string, runsDir: string, claudeHome: string): string {
      return localClaudeSandboxProfile(runId, claudeHome, {
        repoRoot: config.repoRoot,
        dataDir,
        runsDir,
        variantsDir: path.join(dataDir, 'variants'),
        featuresDir: path.join(config.vaultDir, `Project ${config.evalProduct}`, 'Features'),
        home: os.homedir(),
      });
    },
  };
}

export type Variants = ReturnType<typeof createVariants>;
