import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';
import {
  callLinear,
  LINEAR_MCP_URL,
  EVAL_TEAM,
  linearLoggedIn,
  renewLinearClient,
} from './external/linear.js';
import { ORG } from './external/github.js';
import {
  anthropic,
  type Models,
  parseStructuredResponse,
  structuredRequest,
} from './llm/client.js';
import type { VaultSource } from './config.js';
import { writeCodexHome } from './variants/codex-home.js';

const LINUX_TARGET = 'x86_64-unknown-linux-gnu';

// Contracts section 8: check each condition this machine needs to run evaluations, actually running each one
export const EnvironmentCheck = z.object({
  id: z.string(),
  label: z.string(),
  ok: z.boolean(),
  // On pass, the version, account etc. found; on failure, an excerpt of the real output
  detail: z.string(),
  // On failure, the command to run or the thing to do
  fix: z.string(),
});
export type EnvironmentCheck = z.infer<typeof EnvironmentCheck>;

export const EnvironmentReport = z.object({
  checkedAt: z.number(),
  checks: z.array(EnvironmentCheck),
});
export type EnvironmentReport = z.infer<typeof EnvironmentReport>;

export interface EnvironmentOptions {
  // The role models currently in effect (change immediately when Settings is saved)
  models: () => Models;
  vaultDir: string;
  vaultSource: VaultSource;
  product: string;
  txeWorkflowRepo: string;
  ctxBin: string;
  codexAuthPath: string;
  codexConfigPath: string;
  // data/environment: CODEX_HOME and working directory for the Codex check
  workDir: string;
  // Whether a Linux SSH host exists: only then check the tools to cross-compile wf (Contracts 31.5); absent means none
  remoteLinux?: (() => boolean) | undefined;
}

const CACHE_MS = 10 * 60_000;
const EXCERPT_CHARS = 1500;

// Keep only the end of the output: the cause of an error is usually last
function excerpt(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= EXCERPT_CHARS ? trimmed : `…${trimmed.slice(-EXCERPT_CHARS)}`;
}

interface CommandOutcome {
  ok: boolean;
  stdout: string;
  output: string;
}

// A missing command, non-zero exit or timeout counts as failed; the output is kept as is for detail
async function command(
  file: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<CommandOutcome> {
  const result = await execa(file, args, {
    reject: false,
    stdin: 'ignore',
    all: true,
    timeout: options.timeoutMs ?? 30_000,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const output = result.failed
    ? [result.shortMessage, result.all].filter((s) => s !== undefined && s !== '').join('\n')
    : result.all;
  return { ok: !result.failed, stdout: result.stdout, output: excerpt(output) };
}

// An error thrown by the check's own operation (model request, Linear call, Codex config setup) is the failure reason
async function attempt<T>(
  run: () => T | Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  return Promise.resolve()
    .then(run)
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({
        ok: false as const,
        error: excerpt(error instanceof Error ? error.message : String(error)),
      }),
    );
}

async function versionCheck(
  id: string,
  label: string,
  file: string,
  fix: string,
): Promise<EnvironmentCheck> {
  const result = await command(file, ['--version']);
  return { id, label, ok: result.ok, detail: result.output, fix };
}

const roleLabels: Record<keyof Models, string> = {
  simulatedUser: 'Simulated user',
  judge: 'Grading (judge)',
};

const roleIds: Record<keyof Models, string> = {
  simulatedUser: 'model-simulated-user',
  judge: 'model-judge',
};

// A request of exactly the same shape as the simulated user's and judge's (strict tool respond, Contracts 4):
// it fails too when the gateway routes the model to a channel that rejects strict tools (e.g. Bedrock's tools.0.custom.strict)
const PingResult = z.object({ reply: z.string().min(1) });

async function modelCheck(role: keyof Models, model: string): Promise<EnvironmentCheck> {
  const started = performance.now();
  const result = await attempt(async () =>
    parseStructuredResponse(
      await anthropic().messages.create(
        structuredRequest({
          model,
          system: 'This is a connectivity check.',
          user: 'Put pong in reply.',
          schema: PingResult,
          maxTokens: 2000,
        }),
      ),
      PingResult,
      model,
    ),
  );
  const ms = Math.round(performance.now() - started);
  const fix = `In Settings on the Runs page, choose another model for "${roleLabels[role]}" and save; on 401, check ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL under env in ~/.claude/settings.json`;
  return {
    id: roleIds[role],
    label: `gateway: ${roleLabels[role]} model ${model}`,
    ok: result.ok,
    detail: result.ok ? `${String(ms)} ms, respond: ${result.value.value.reply}` : result.error,
    fix,
  };
}

const GH_NETWORK_ERROR =
  /TLS handshake timeout|connection refused|connection reset|no such host|error connecting to|dial tcp|i\/o timeout|network is unreachable|context deadline exceeded|timed out after|: EOF$/im;
const GH_AUTH_ERROR = /not logged into any GitHub hosts|gh auth login|Bad credentials|HTTP 401/i;
type GhFailure = 'network' | 'auth' | 'other';

function ghFailure(output: string): GhFailure {
  if (GH_NETWORK_ERROR.test(output)) return 'network';
  if (GH_AUTH_ERROR.test(output)) return 'auth';
  return 'other';
}

// The gh fix follows gh's actual error: suggest logging in only when not logged in or the token is invalid
function ghFix(output: string): string {
  switch (ghFailure(output)) {
    case 'network':
      return 'Network problem, cannot reach GitHub: check the network or proxy, then click "Recheck"';
    case 'auth':
      return 'gh auth login --hostname github.com --git-protocol https --web';
    case 'other':
      return 'Resolve the gh output above, then click "Recheck"';
  }
}

export async function githubCheck(): Promise<EnvironmentCheck> {
  const base = { id: 'gh', label: `GitHub: gh logged in as a member of ${ORG}` };
  const status = await command('gh', ['auth', 'status']);
  const user = await command('gh', ['api', 'user', '--jq', '.login']);
  if (!status.ok || !user.ok) {
    // gh auth status also reports an invalid token when GitHub is unreachable: trust the output of gh api user
    const output = user.ok ? status.output : user.output;
    return { ...base, ok: false, detail: output, fix: ghFix(output) };
  }
  const login = user.stdout.trim();
  const membership = await command('gh', [
    'api',
    `user/memberships/orgs/${ORG}`,
    '--jq',
    '.state + " " + .role',
  ]);
  const active = membership.ok && membership.stdout.startsWith('active ');
  const orgFix = `Log in again with a member account of ${ORG}: gh auth login --hostname github.com --web; or ask a ${ORG} admin to invite ${login} to the organization`;
  return {
    ...base,
    ok: active,
    detail: active
      ? `Account ${login}, member of ${ORG} (${membership.stdout.trim()})`
      : `Account ${login}: ${membership.output}`,
    // Not a member (404 or invitation not accepted): suggest another account or an invitation; network and auth errors by type
    fix:
      membership.ok || ghFailure(membership.output) === 'other' ? orgFix : ghFix(membership.output),
  };
}

const Teams = z
  .object({ teams: z.array(z.object({ key: z.string(), name: z.string() }).loose()) })
  .loose();

const linearLogin = `Run npx -y mcp-remote ${LINEAR_MCP_URL} in a terminal, authorize Linear in the browser that opens, press Ctrl-C after Proxy established appears, then click "Recheck"`;
const AUTH_ERROR = /\b401\b|invalid_token|unauthori[sz]ed|authorization|not logged in/i;
const NETWORK_ERROR =
  /fetch failed|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|Connection closed|Not connected|timed out|-3200[01]/i;

// The fix for a failed Linear call follows the kind of error: suggest re-authorizing only when authorization is needed
export function linearFix(error: string): string {
  if (AUTH_ERROR.test(error)) return linearLogin;
  if (NETWORK_ERROR.test(error)) {
    return 'A network interruption broke the connection to Linear; once the network is back, click "Recheck" to retry with a new connection';
  }
  return 'detail holds the original text returned by Linear MCP; resolve it, then click "Recheck"';
}

async function linearCheck(): Promise<EnvironmentCheck> {
  const base = { id: 'linear', label: 'Linear MCP: list_teams' };
  if (!linearLoggedIn()) {
    return {
      ...base,
      ok: false,
      detail: 'No Linear MCP OAuth token in ~/.mcp-auth/mcp-remote-v1 (mcp-remote not logged in)',
      fix: linearLogin,
    };
  }
  const result = await attempt(() => callLinear('list_teams', {}, Teams));
  if (!result.ok) return { ...base, ok: false, detail: result.error, fix: linearFix(result.error) };
  const keys = result.value.teams.map((t) => t.key);
  if (!keys.includes(EVAL_TEAM)) {
    return {
      ...base,
      ok: false,
      detail: `${String(keys.length)} teams (${keys.join(', ')}), none is the evaluation team ${EVAL_TEAM}`,
      fix: `Delete the Linear token in ~/.mcp-auth/mcp-remote-v1, then authorize with an account that can access the ${EVAL_TEAM} team: npx -y mcp-remote ${LINEAR_MCP_URL}`,
    };
  }
  return {
    ...base,
    ok: true,
    detail: `${String(keys.length)} teams, including ${EVAL_TEAM}`,
    fix: linearLogin,
  };
}

// The Codex model /review-pr uses: the first line of codex-models.txt that is neither blank nor a comment
function reviewModel(txeWorkflowRepo: string): string {
  const file = path.join(txeWorkflowRepo, 'skills/review-pr/references/codex-models.txt');
  const model = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '' && !line.startsWith('#'));
  if (model === undefined) throw new Error(`No model in ${file}`);
  return model;
}

async function codexCheck(options: EnvironmentOptions): Promise<EnvironmentCheck> {
  const codexHome = path.join(options.workDir, 'codex-home');
  const cwd = path.join(options.workDir, 'codex-work');
  const base = { id: 'codex', label: 'Codex: codex exec under a separate CODEX_HOME' };
  const prepared = await attempt(() => {
    writeCodexHome(codexHome, {
      authPath: options.codexAuthPath,
      configPath: options.codexConfigPath,
    });
    fs.mkdirSync(cwd, { recursive: true });
    return reviewModel(options.txeWorkflowRepo);
  });
  if (!prepared.ok) {
    return {
      ...base,
      ok: false,
      detail: prepared.error,
      fix: `Run codex login to create ${options.codexAuthPath}; make sure ${options.codexConfigPath} exists and is valid TOML, and ${options.txeWorkflowRepo}/skills/review-pr/references/codex-models.txt contains a model`,
    };
  }
  const model = prepared.value;
  const args = [
    'exec',
    '--skip-git-repo-check',
    '-m',
    model,
    '-s',
    'read-only',
    'Reply with exactly: pong',
  ];
  const started = performance.now();
  const result = await command('codex', args, {
    cwd,
    env: { CODEX_HOME: codexHome },
    timeoutMs: 180_000,
  });
  const seconds = Math.round((performance.now() - started) / 1000);
  const ok = result.ok && result.stdout.toLowerCase().includes('pong');
  const reproduce = `CODEX_HOME="${codexHome}" codex ${args.slice(0, -1).join(' ')} 'Reply with exactly: pong'`;
  const hint = /quota exceeded/i.test(result.output)
    ? 'Quota exceeded: restore the quota of the account behind model_provider in ~/.codex/config.toml, or switch to a provider with quota. '
    : /401|unauthorized|missing bearer|not logged in/i.test(result.output)
      ? 'Authentication failed: run codex login to log in again. '
      : '';
  return {
    ...base,
    ok,
    detail: ok
      ? `codex exec -m ${model} returned ${result.stdout.trim()} (${String(seconds)} s)`
      : result.output,
    fix: `${hint}Reproduce in a terminal and fix ~/.codex/auth.json or ~/.codex/config.toml from the output: ${reproduce}`,
  };
}

// Vault location and source (Contracts section 30), e.g. "/Users/x/Documents/Obsidian Vault (from MAGI_VAULT)"
function vaultLocation(vaultDir: string, source: VaultSource): string {
  return `${vaultDir} (${source === 'MAGI_VAULT' ? 'from MAGI_VAULT' : 'default, MAGI_VAULT not set'})`;
}

export async function vaultCheck(
  vaultDir: string,
  source: VaultSource,
  product: string,
): Promise<EnvironmentCheck> {
  const productDir = path.join(vaultDir, `Project ${product}`);
  const base = { id: 'vault', label: `Obsidian vault and Project ${product}/` };
  const location = vaultLocation(vaultDir, source);
  if (!fs.existsSync(vaultDir)) {
    return {
      ...base,
      ok: false,
      detail: `${location}: does not exist`,
      fix: `Open or create a vault in Obsidian and add export MAGI_VAULT='<vault path>' to your shell config file (e.g. ~/.zshrc), as txe-workflow's /install does; reopen the terminal, then restart the dashboard`,
    };
  }
  const fix = `mkdir -p "${productDir}" (wf obsidian requires the product directory to exist)`;
  if (!fs.existsSync(productDir)) {
    return { ...base, ok: false, detail: `${location}: no Project ${product}/`, fix };
  }
  const writable = await attempt(() => fs.promises.access(productDir, fs.constants.W_OK));
  if (!writable.ok)
    return {
      ...base,
      ok: false,
      detail: `${location}: ${writable.error}`,
      fix: `chmod u+w "${productDir}"`,
    };
  const features = path.join(productDir, 'Features');
  const runs = fs.existsSync(features) ? fs.readdirSync(features).length : 0;
  return {
    ...base,
    ok: true,
    detail: `${location}, Project ${product}/ is writable, ${String(runs)} directories under Features/`,
    fix,
  };
}

async function txeWorkflowCheck(repo: string): Promise<EnvironmentCheck> {
  const base = {
    id: 'txe-workflow',
    label: 'txe-workflow repo',
    fix: `git clone https://github.com/txehq/txe-workflow.git "${repo}"`,
  };
  const head = await command('git', ['-C', repo, 'log', '-1', '--format=%h %s']);
  if (!head.ok) return { ...base, ok: false, detail: head.output };
  const skills = path.join(repo, 'skills');
  if (!fs.existsSync(skills)) {
    return { ...base, ok: false, detail: `${skills} does not exist (HEAD ${head.stdout.trim()})` };
  }
  const count = fs.readdirSync(skills).length;
  return {
    ...base,
    ok: true,
    detail: `${repo}, HEAD ${head.stdout.trim()}, ${String(count)} skills`,
  };
}

// A variant on a remote Linux host needs wf cross-compiled on this machine (Contracts 31.5): cargo-zigbuild, zig and the
// Linux target on the toolchain txe-workflow pins (rustup runs in the repo directory, taking the toolchain from rust-toolchain.toml)
export async function crossCompileCheck(repo: string): Promise<EnvironmentCheck> {
  const base = {
    id: 'cross-compile',
    label: 'Cross-compile wf: variants on remote Linux hosts',
    fix: `brew install cargo-zigbuild zig; run rustup target add ${LINUX_TARGET} in the txe-workflow directory (cd "${repo}")`,
  };
  // Through cargo, --version is taken as a zigbuild argument (0.24.0 exits with 2), so ask cargo-zigbuild for the version;
  // cargo zigbuild --help proves cargo finds the subcommand under the pinned toolchain
  const subcommand = await command('cargo', ['zigbuild', '--help'], { cwd: repo });
  if (!subcommand.ok) return { ...base, ok: false, detail: subcommand.output };
  const zigbuild = await command('cargo-zigbuild', ['--version']);
  if (!zigbuild.ok) return { ...base, ok: false, detail: zigbuild.output };
  const zig = await command('zig', ['version']);
  if (!zig.ok) return { ...base, ok: false, detail: zig.output };
  const targets = await command('rustup', ['target', 'list', '--installed'], { cwd: repo });
  if (!targets.ok) return { ...base, ok: false, detail: targets.output };
  const installed = targets.stdout.split('\n').map((t) => t.trim());
  if (!installed.includes(LINUX_TARGET)) {
    return {
      ...base,
      ok: false,
      detail: `The toolchain of ${repo} has no ${LINUX_TARGET}, installed: ${installed.filter((t) => t !== '').join(', ')}`,
    };
  }
  return {
    ...base,
    ok: true,
    detail: `${zigbuild.stdout.trim()}, zig ${zig.stdout.trim()}, target ${LINUX_TARGET}`,
  };
}

export async function runEnvironmentChecks(
  options: EnvironmentOptions,
): Promise<EnvironmentReport> {
  const models = options.models();
  const checks = await Promise.all([
    versionCheck(
      'claude',
      'claude executable',
      'claude',
      'npm install --global @anthropic-ai/claude-code, and make sure claude is on PATH',
    ),
    modelCheck('simulatedUser', models.simulatedUser),
    modelCheck('judge', models.judge),
    githubCheck(),
    linearCheck(),
    codexCheck(options),
    vaultCheck(options.vaultDir, options.vaultSource, options.product),
    txeWorkflowCheck(options.txeWorkflowRepo),
    versionCheck(
      'wf',
      'wf executable',
      'wf',
      'Install wf following the txe-workflow README (run /install in Claude Code), and make sure ~/.local/bin is on PATH',
    ),
    versionCheck('uv', 'uv executable', 'uv', 'curl -LsSf https://astral.sh/uv/install.sh | sh'),
    versionCheck(
      'ctx',
      'ctx executable',
      options.ctxBin,
      `Run wf doctor and fix what capso.ctx.binary reports (wf install puts ctx at ${options.ctxBin})`,
    ),
    ...(options.remoteLinux?.() === true ? [crossCompileCheck(options.txeWorkflowRepo)] : []),
  ]);
  return { checkedAt: Date.now(), checks };
}

// Results are cached 10 minutes; after the role models change (Settings saved) the next read checks again; only one check
// per set of models runs at a time, and a model change during a check starts another, never returning old-model results
export function createEnvironment(options: EnvironmentOptions) {
  let cached: { report: EnvironmentReport; modelsKey: string } | undefined;
  let inflight: { promise: Promise<EnvironmentReport>; modelsKey: string } | undefined;

  function check(): Promise<EnvironmentReport> {
    const modelsKey = JSON.stringify(options.models());
    if (inflight?.modelsKey === modelsKey) return inflight.promise;
    const promise = (async () => {
      const report = await runEnvironmentChecks(options).finally(() => {
        if (inflight?.promise === promise) inflight = undefined;
      });
      cached = { report, modelsKey };
      return report;
    })();
    inflight = { promise, modelsKey };
    return promise;
  }

  return {
    get(refresh: boolean): Promise<EnvironmentReport> {
      // A recheck uses a new Linear connection: after a network interruption the old one may keep returning errors
      if (refresh) renewLinearClient();
      if (
        !refresh &&
        cached !== undefined &&
        Date.now() - cached.report.checkedAt < CACHE_MS &&
        cached.modelsKey === JSON.stringify(options.models())
      ) {
        return Promise.resolve(cached.report);
      }
      return check();
    },
  };
}

export type Environment = ReturnType<typeof createEnvironment>;
