import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { quote } from 'shell-quote';
import { z } from 'zod';
import type { Variant, Variants } from '../variants/index.js';
import { RELEASE_REPO } from '../variants/release.js';
import { isWfWorkflow } from '../workflows/schema.js';
import { ORCA_SKILLS } from '../orca/skills.js';
import type { RemoteHost } from './hosts.js';
import { rsyncPush, sshRun } from './ssh.js';
import { remoteRoot } from './terminal.js';

// Variants running on an SSH host (Contracts 31.5): Claude Code only. The remote variant config directory is
// $HOME/.wf-dashboard/variants/<variantId>/ (CLAUDE_CONFIG_DIR); its .wfd/ holds the dashboard's own files:
// the variant's src/ and build-local's dist/, WF_HOME, CODEX_HOME, TMPDIR and the built_hash marker file.
// wf lives at $HOME/.wf-dashboard/bin/<commit>/wf

export interface RemoteVariant {
  // The remote variant config directory
  configDir: string;
  // The remote process environment: env from the remote ~/.claude/settings.json (credentials stay the remote's) plus the variant's variables, PATH starting with the variant's wf
  env: Record<string, string>;
}

// Launch progress (Contracts 28.4): one line at the start and end of each step, the end line with the actual duration
export type RemoteLog = (line: string) => void;

// Download these files of a txe-workflow release into dir
export type DownloadRelease = (tag: string, names: string[], dir: string) => Promise<void>;

export interface RemoteVariantsOptions {
  variants: Variants;
  dataDir: string;
  // txe-workflow repository: exports the source for cross-compiling and looks up tags on a commit
  repo: string;
  downloadRelease?: DownloadRelease | undefined;
}

// Rust target for each uname -sm
const PLATFORMS: Record<string, string> = {
  'Linux x86_64': 'x86_64-unknown-linux-gnu',
  'Linux aarch64': 'aarch64-unknown-linux-gnu',
  'Darwin arm64': 'aarch64-apple-darwin',
  'Darwin x86_64': 'x86_64-apple-darwin',
};

export function remotePlatform(uname: string): string {
  const platform = PLATFORMS[uname.trim()];
  if (platform === undefined) {
    throw new Error(
      `No wf build for remote platform ${uname.trim()} (supported: ${Object.keys(PLATFORMS).join(', ')})`,
    );
  }
  return platform;
}

// Linux wf is always built on this machine with cargo-zigbuild against this glibc: the txe-workflow release's Linux package needs glibc 2.39,
// which does not run on Ubuntu 22.04 (2.35); 2.17 does not compile (Rust std uses statx). Runs on Ubuntu 20.04 and Debian 10 onwards
export const LINUX_GLIBC = '2.28';
// Concurrent rustc processes while cross-compiling: keeps this machine's load at most 2 during the build
export const CROSS_JOBS = 2;

export const releaseAssets = (tag: string, platform: string) => ({
  archive: `wf-${tag}-${platform}.tar.gz`,
  checksums: `checksums-${tag}.txt`,
});

const ghDownload: DownloadRelease = async (tag, names, dir) => {
  await execa('gh', [
    'release',
    'download',
    tag,
    '--repo',
    RELEASE_REPO,
    '--dir',
    dir,
    '--clobber',
    ...names.flatMap((name) => ['--pattern', name]),
  ]);
};

// Prebuilt release package for macOS: download, verify against the same release's checksums, extract wf to out
export async function releaseRuntime(
  download: DownloadRelease,
  tag: string,
  platform: string,
  out: string,
) {
  const dir = path.join(path.dirname(out), `download-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  const { archive, checksums } = releaseAssets(tag, platform);
  await download(tag, [archive, checksums], dir);
  // checksums is in sha256sum format; verify only the one file downloaded
  await execa('shasum', ['-a', '256', '--check', '--ignore-missing', '--strict', checksums], {
    cwd: dir,
  });
  await execa('tar', ['-xzf', path.join(dir, archive), '-C', dir, 'wf']);
  fs.renameSync(path.join(dir, 'wf'), out);
  fs.rmSync(dir, { recursive: true });
}

const RemoteSettings = z.looseObject({ env: z.record(z.string(), z.string()).optional() });
const RemoteClaudeState = z.looseObject({
  hasCompletedOnboarding: z.boolean().optional(),
  projects: z
    .record(z.string(), z.looseObject({ hasTrustDialogAccepted: z.boolean().optional() }))
    .optional(),
});

// Remote paths: the config directory and wf live under the remote $HOME/.wf-dashboard (remoteRoot)
function remoteLayout(host: RemoteHost, variantId: string, commit: string) {
  const root = remoteRoot(host);
  const configDir = root.variant(variantId);
  const own = path.posix.join(configDir, '.wfd');
  return {
    configDir,
    own,
    src: path.posix.join(own, 'src'),
    dist: path.posix.join(own, 'dist'),
    wfHome: path.posix.join(own, 'wf'),
    wfBinDir: path.posix.join(own, 'wf', 'bin'),
    codexHome: path.posix.join(own, 'codex'),
    tmp: path.posix.join(own, 'tmp'),
    marker: path.posix.join(own, 'built-hash'),
    runtime: path.posix.join(root.root, 'bin', commit, 'wf'),
  };
}

export function createRemoteVariants({
  variants,
  dataDir,
  repo,
  downloadRelease = ghDownload,
}: RemoteVariantsOptions) {
  // At most one sync per variant per host, and one wf per commit and platform, at a time
  const syncs = new Map<string, Promise<RemoteVariant>>();
  const runtimes = new Map<string, Promise<string>>();

  // Run a script with sh on the remote and return stdout; with login it runs in the remote user's login shell (same PATH as the check).
  // Fails with the output of ssh and the remote command
  function remote(
    host: RemoteHost,
    script: string,
    opts: { input?: string; login?: boolean } = {},
  ): Promise<string> {
    const sh = quote(['sh', '-c', script]);
    return sshRun(host.target, opts.login === true ? `exec "$SHELL" -lc ${quote([sh])}` : sh, {
      ...(opts.input === undefined ? {} : { input: opts.input }),
    });
  }

  // rsync through the same ControlMaster, with the remote rsync at the location recorded by the check
  const rsync = (host: RemoteHost, from: string, to: string, extra: string[] = []) =>
    rsyncPush(host.target, host.tool('rsync'), from, to, extra);

  async function step<T>(
    log: RemoteLog,
    name: string,
    run: () => Promise<T>,
    detail: (value: T) => string,
  ) {
    log(`${name}…`);
    const started = performance.now();
    const value = await run();
    const seconds = (Math.round(performance.now() - started) / 1000).toFixed(1);
    log(`${name}: ${detail(value)} (${seconds} s)`);
    return value;
  }

  // A remote JSON file: read, edit, write back (to a temporary file, then rename). Starts from {} when the file does not exist
  async function editRemoteJson<S extends z.ZodType>(
    host: RemoteHost,
    file: string,
    schema: S,
    edit: (value: z.infer<S>) => unknown,
  ) {
    const text = await remote(host, `if [ -f ${quote([file])} ]; then cat ${quote([file])}; fi`);
    const next = edit(schema.parse(text.trim() === '' ? {} : JSON.parse(text)));
    const tmp = `${file}.${randomUUID()}.tmp`;
    const write = `umask 077 && cat > ${quote([tmp])} && mv ${quote([tmp])} ${quote([file])}`;
    await remote(host, write, { input: `${JSON.stringify(next, null, 2)}\n` });
  }

  // runtimes/<commit>/<platform>/wf on this machine
  const cachedRuntime = (commit: string, platform: string) =>
    path.join(dataDir, 'runtimes', commit, platform, 'wf');

  // The txe-workflow release tag on commit (the highest v*); null for a commit that is not a release
  async function releaseTagOf(commit: string): Promise<string | null> {
    const { stdout } = await execa('git', [
      '-C',
      repo,
      'tag',
      '--points-at',
      commit,
      '--list',
      'v*',
      '--sort=-v:refname',
    ]);
    return stdout.split('\n').find((tag) => tag !== '') ?? null;
  }

  // Cross-compile on this machine: Linux with cargo-zigbuild against LINUX_GLIBC, macOS with cargo's --target; the toolchain as pinned by txe-workflow
  async function compileRuntime(commit: string, platform: string, out: string, log: RemoteLog) {
    const src = path.join(path.dirname(out), `src-${randomUUID()}`);
    fs.mkdirSync(src, { recursive: true });
    const tar = `${src}.tar`;
    await execa('git', ['-C', repo, 'archive', '--format=tar', '-o', tar, commit]);
    await execa('tar', ['-xf', tar, '-C', src]);
    fs.rmSync(tar);
    const linux = platform.endsWith('-linux-gnu');
    const args = [
      ...(linux ? ['zigbuild'] : ['build']),
      '--release',
      '--locked',
      '-p',
      'wf-cli',
      '-j',
      String(CROSS_JOBS),
      '--target',
      linux ? `${platform}.${LINUX_GLIBC}` : platform,
    ];
    const target = path.join(dataDir, 'cargo-target');
    log(`cargo ${args.join(' ')}`);
    await execa('cargo', args, { cwd: src, env: { CARGO_TARGET_DIR: target } });
    const partial = `${out}.${randomUUID()}.partial`;
    fs.copyFileSync(path.join(target, platform, 'release', 'wf'), partial);
    fs.renameSync(partial, out);
    fs.rmSync(src, { recursive: true });
  }

  // wf for the remote platform: the prebuilt release package on macOS when commit is a release tag, otherwise cross-compiled here; cached on this machine
  async function ensureRuntime(commit: string, platform: string, log: RemoteLog): Promise<string> {
    const out = cachedRuntime(commit, platform);
    if (fs.existsSync(out)) {
      log(`wf: reusing ${out}`);
      return out;
    }
    const key = `${commit}/${platform}`;
    let pending = runtimes.get(key);
    if (pending === undefined) {
      pending = (async () => {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        const tag = platform.endsWith('-apple-darwin') ? await releaseTagOf(commit) : null;
        if (tag === null) {
          await step(
            log,
            'compile-wf',
            () => compileRuntime(commit, platform, out, log),
            () => out,
          );
        } else {
          await step(
            log,
            'download-wf',
            () => releaseRuntime(downloadRelease, tag, platform, out),
            () => `${releaseAssets(tag, platform).archive}, checksums verified → ${out}`,
          );
        }
        return out;
      })().finally(() => runtimes.delete(key));
      runtimes.set(key, pending);
    } else {
      log(`wf: waiting for another launch preparing wf ${key}`);
    }
    return pending;
  }

  // lfg and ic variants: the variant's src/ and wf go to the remote, build-local runs there, then wf install --agent claude
  async function installWf(
    host: RemoteHost,
    row: Variant,
    remoteDirs: ReturnType<typeof remoteLayout>,
    platform: string,
    log: RemoteLog,
  ) {
    const local = await ensureRuntime(row.baseCommit, platform, log);
    const dirs = variants.layout(row.id);
    await step(
      log,
      'rsync-wf',
      async () => {
        await remote(
          host,
          `mkdir -p ${quote([path.posix.dirname(remoteDirs.runtime), remoteDirs.own])}`,
        );
        await rsync(host, local, remoteDirs.runtime);
      },
      () => `${local} → ${host.target}:${remoteDirs.runtime}`,
    );
    await step(
      log,
      'rsync-src',
      () => rsync(host, `${dirs.src}/`, `${remoteDirs.src}/`, ['--delete']),
      () => `${dirs.src} → ${host.target}:${remoteDirs.src}`,
    );
    const env = quote([
      'env',
      `WF_HOME=${remoteDirs.wfHome}`,
      `CLAUDE_CONFIG_DIR=${remoteDirs.configDir}`,
      `CODEX_HOME=${remoteDirs.codexHome}`,
      `TMPDIR=${remoteDirs.tmp}`,
    ]);
    const wf = path.posix.join(remoteDirs.wfBinDir, 'wf');
    // Each time, start from an empty dist, WF_HOME and the files wf installs into the config directory; .claude.json (trust and onboarding) and projects/ (sessions) stay
    await step(
      log,
      'remote-clean',
      () =>
        remote(
          host,
          [
            `rm -rf ${quote([remoteDirs.dist, remoteDirs.wfHome, remoteDirs.codexHome, remoteDirs.tmp, ...['skills', 'CLAUDE.md', 'settings.json'].map((f) => path.posix.join(remoteDirs.configDir, f))])}`,
            `mkdir -p ${quote([remoteDirs.wfBinDir, remoteDirs.codexHome, remoteDirs.tmp])}`,
            `cp ${quote([remoteDirs.runtime, wf])}`,
          ].join(' && '),
        ),
      () => remoteDirs.own,
    );
    const wfStep = (name: string, args: string[]) =>
      step(
        log,
        name,
        () => remote(host, `cd ${quote([remoteDirs.src])} && ${env} ${quote([wf, ...args])}`),
        (stdout) => stdout.trim().split('\n').at(-1) ?? '',
      );
    await wfStep('build-local', [
      'release',
      'build-local',
      '--root',
      remoteDirs.src,
      '--out',
      remoteDirs.dist,
      '--version',
      row.version,
    ]);
    await wfStep('install', [
      'install',
      '--source',
      `local:${remoteDirs.dist}`,
      '--agent',
      'claude',
    ]);
    // As locally: wf manages only the variant's Claude config directory
    await wfStep('unregister-codex', ['agents', 'unregister', 'codex']);
    await wfStep('status', ['status']);
  }

  // Variants of other workflows (18.6): the skills installed by the local build go to the remote config directory
  async function installOwn(
    host: RemoteHost,
    row: Variant,
    remoteDirs: ReturnType<typeof remoteLayout>,
    log: RemoteLog,
  ) {
    const skills = path.join(variants.layout(row.id).claudeDir, 'skills');
    const to = path.posix.join(remoteDirs.configDir, 'skills');
    await step(
      log,
      'rsync-skills',
      async () => {
        await remote(
          host,
          `mkdir -p ${quote([remoteDirs.own])} && rm -f ${quote([path.posix.join(remoteDirs.configDir, 'settings.json')])}`,
        );
        await rsync(host, `${skills}/`, `${to}/`, ['--delete']);
      },
      () => `${skills} → ${host.target}:${to}`,
    );
  }

  async function sync(host: RemoteHost, row: Variant, log: RemoteLog): Promise<RemoteVariant> {
    const builtHash = row.builtHash;
    if (row.buildStatus !== 'built' || builtHash === null || builtHash !== row.skillsHash) {
      throw new Error(
        `Variant ${row.name} is not built from its current content and cannot run on ${host.label}`,
      );
    }
    const remoteDirs = remoteLayout(host, row.id, row.baseCommit);
    // The remote marker: the build's built_hash, plus the Orca version when Orca skills are included (a rebuild after an Orca update must sync again)
    const installKey =
      row.orcaVersion === null ? builtHash : `${builtHash}+orca-${row.orcaVersion}`;
    const installLabel = `built_hash ${builtHash.slice(0, 8)}${row.orcaVersion === null ? '' : ` (Orca ${row.orcaVersion})`}`;
    // Platform and $HOME come from the host check; PATH is read in the login shell (as when run.sh runs claude), the remote marker together with settings.json
    const probe = await step(
      log,
      'probe',
      async () => {
        const settings = '"$HOME"/.claude/settings.json';
        const [remotePath = '', remoteHash = '', ...rest] = (
          await remote(
            host,
            [
              `printf '%s\\n' "$PATH"`,
              `if [ -f ${quote([remoteDirs.marker])} ]; then cat ${quote([remoteDirs.marker])}; fi; echo`,
              `if [ -f ${settings} ]; then cat ${settings}; fi`,
            ].join('; '),
            { login: true },
          )
        ).split('\n');
        const settingsText = rest.join('\n').trim();
        return {
          platform: remotePlatform(host.check.platform ?? '(no platform in the check)'),
          remotePath,
          remoteHash: remoteHash.trim(),
          settingsEnv:
            RemoteSettings.parse(settingsText === '' ? {} : JSON.parse(settingsText)).env ?? {},
        };
      },
      (p) =>
        `${p.platform}, $HOME ${host.home}, remote marker ${p.remoteHash === '' ? 'none' : p.remoteHash.slice(0, 8)}`,
    );
    const env = {
      ...probe.settingsEnv,
      CLAUDE_CONFIG_DIR: remoteDirs.configDir,
      ...(isWfWorkflow(row.workflowId)
        ? {
            WF_HOME: remoteDirs.wfHome,
            CODEX_HOME: remoteDirs.codexHome,
            TMPDIR: remoteDirs.tmp,
            PATH: `${remoteDirs.wfBinDir}:${probe.remotePath}`,
          }
        : {}),
    };
    if (probe.remoteHash === installKey) {
      log(`sync: the remote already has the ${installLabel} build, skipping`);
      return { configDir: remoteDirs.configDir, env };
    }
    if (isWfWorkflow(row.workflowId)) {
      await installWf(host, row, remoteDirs, probe.platform, log);
      // wf install installs only txe-workflow's skills; the included Orca skills are copied from the local build (Contracts 35.5)
      if (row.orcaVersion !== null) {
        const skills = path.join(variants.layout(row.id).claudeDir, 'skills');
        const to = path.posix.join(remoteDirs.configDir, 'skills');
        await step(
          log,
          'rsync-orca-skills',
          async () => {
            for (const name of ORCA_SKILLS) {
              await rsync(host, `${path.join(skills, name)}/`, `${path.posix.join(to, name)}/`, [
                '--delete',
              ]);
            }
          },
          () => `Orca ${String(row.orcaVersion)} ${ORCA_SKILLS.join(', ')} → ${host.target}:${to}`,
        );
      }
    } else {
      await installOwn(host, row, remoteDirs, log);
    }
    // As for local variants: the remote's real CLAUDE.md is not read, onboarding is completed
    const excludes = [
      path.posix.join(host.home, '.claude/CLAUDE.md'),
      path.posix.join(host.home, '.claude/rules/**'),
    ];
    await step(
      log,
      'write-config',
      async () => {
        await editRemoteJson(
          host,
          path.posix.join(remoteDirs.configDir, 'settings.json'),
          RemoteSettings,
          (settings) => ({ ...settings, claudeMdExcludes: excludes }),
        );
        await editRemoteJson(
          host,
          path.posix.join(remoteDirs.configDir, '.claude.json'),
          RemoteClaudeState,
          (state) => ({ ...state, hasCompletedOnboarding: true }),
        );
        await remote(host, `printf '%s' ${quote([installKey])} > ${quote([remoteDirs.marker])}`);
      },
      () =>
        `claudeMdExcludes in settings.json, onboarding completed in .claude.json, marker ${installLabel}`,
    );
    return { configDir: remoteDirs.configDir, env };
  }

  return {
    ensureRuntime,

    // Called before launch and resume: skips the sync when the remote variant config directory has this variant's built_hash
    prepareRemoteVariant(
      host: RemoteHost,
      variantId: string,
      log: RemoteLog,
    ): Promise<RemoteVariant> {
      const key = `${host.id}/${variantId}`;
      let pending = syncs.get(key);
      if (pending === undefined) {
        pending = sync(host, variants.get(variantId), log).finally(() => syncs.delete(key));
        syncs.set(key, pending);
      } else {
        log('sync: waiting for another launch syncing this variant');
      }
      return pending;
    },

    // Before launch and resume, mark the remote cwd as trusted (as trustDirectory does locally): both the given path and the real path
    async trustRemoteDirectory(host: RemoteHost, configDir: string, cwd: string) {
      const real = (await remote(host, `cd ${quote([cwd])} && pwd -P`)).trim();
      await editRemoteJson(
        host,
        path.posix.join(configDir, '.claude.json'),
        RemoteClaudeState,
        (state) => {
          const projects = { ...state.projects };
          for (const dir of new Set([cwd, real])) {
            projects[dir] = { ...projects[dir], hasTrustDialogAccepted: true };
          }
          return { ...state, projects };
        },
      );
    },
  };
}

export type RemoteVariants = ReturnType<typeof createRemoteVariants>;
