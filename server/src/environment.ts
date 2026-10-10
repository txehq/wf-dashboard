import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';
import { callLinear, LINEAR_MCP_URL, EVAL_TEAM, linearLoggedIn } from './external/linear.js';
import { ORG } from './external/github.js';
import { anthropic, type Models } from './llm/client.js';
import { writeCodexHome } from './variants/codex-home.js';

// Contracts 第 8 节：逐项检查本机运行评估所需的条件，每项实际执行一次
export const EnvironmentCheck = z.object({
  id: z.string(),
  label: z.string(),
  ok: z.boolean(),
  // 通过时为检查到的版本、账号等；未通过时为真实输出的摘录
  detail: z.string(),
  // 未通过时要运行的命令或要做的事
  fix: z.string(),
});
export type EnvironmentCheck = z.infer<typeof EnvironmentCheck>;

export const EnvironmentReport = z.object({
  checkedAt: z.number(),
  checks: z.array(EnvironmentCheck),
});
export type EnvironmentReport = z.infer<typeof EnvironmentReport>;

export interface EnvironmentOptions {
  // 当前生效的三个角色模型（Settings 修改后立即变化）
  models: () => Models;
  vaultDir: string;
  product: string;
  txeWorkflowRepo: string;
  ctxBin: string;
  codexAuthPath: string;
  codexConfigPath: string;
  // data/environment：Codex 检查的 CODEX_HOME 与工作目录
  workDir: string;
}

const CACHE_MS = 10 * 60_000;
const EXCERPT_CHARS = 1500;

// 输出只保留末尾：错误原因通常在最后
function excerpt(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= EXCERPT_CHARS ? trimmed : `…${trimmed.slice(-EXCERPT_CHARS)}`;
}

interface CommandOutcome {
  ok: boolean;
  stdout: string;
  output: string;
}

// 命令不存在、非零退出、超时都记为未通过，输出原样保留给 detail
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

// 检查本身的操作（模型请求、Linear 调用、Codex 配置准备）抛出的错误就是未通过的原因
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
  simulatedUser: '模拟用户',
  judge: '评分（judge）',
  stageCheck: '阶段判定',
};

const roleIds: Record<keyof Models, string> = {
  simulatedUser: 'model-simulated-user',
  judge: 'model-judge',
  stageCheck: 'model-stage-check',
};

async function modelCheck(role: keyof Models, model: string): Promise<EnvironmentCheck> {
  const started = performance.now();
  const result = await attempt(() =>
    anthropic().messages.create({
      model,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
    }),
  );
  const ms = Math.round(performance.now() - started);
  const fix =
    role === 'stageCheck'
      ? '在 Runs 页面的「设置」里把「阶段判定」改为 gateway 上可用的模型（例如 claude-sonnet-5）并保存；或启动服务前设置 WFD_STAGE_CHECK_MODEL=claude-sonnet-5'
      : `在 Runs 页面的「设置」里把「${roleLabels[role]}」改为 gateway 上可用的模型并保存；401 时检查 ~/.claude/settings.json 中 env 的 ANTHROPIC_AUTH_TOKEN 与 ANTHROPIC_BASE_URL`;
  return {
    id: roleIds[role],
    label: `gateway：${roleLabels[role]}模型 ${model}`,
    ok: result.ok,
    detail: result.ok
      ? `${String(ms)} ms，回复：${result.value.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('')
          .trim()}`
      : result.error,
    fix,
  };
}

async function githubCheck(): Promise<EnvironmentCheck> {
  const base = { id: 'gh', label: `GitHub：gh 已登录且是 ${ORG} 成员` };
  const status = await command('gh', ['auth', 'status']);
  if (!status.ok) {
    return {
      ...base,
      ok: false,
      detail: status.output,
      fix: 'gh auth login --hostname github.com --git-protocol https --web',
    };
  }
  const login = (await command('gh', ['api', 'user', '--jq', '.login'])).stdout.trim();
  const membership = await command('gh', [
    'api',
    `user/memberships/orgs/${ORG}`,
    '--jq',
    '.state + " " + .role',
  ]);
  const active = membership.ok && membership.stdout.startsWith('active ');
  return {
    ...base,
    ok: active,
    detail: active
      ? `账号 ${login}，${ORG} 成员（${membership.stdout.trim()}）`
      : `账号 ${login}：${membership.output}`,
    fix: `用 ${ORG} 的成员账号重新登录：gh auth login --hostname github.com --web；或请 ${ORG} 管理员邀请 ${login} 加入组织`,
  };
}

const Teams = z
  .object({ teams: z.array(z.object({ key: z.string(), name: z.string() }).loose()) })
  .loose();

async function linearCheck(): Promise<EnvironmentCheck> {
  const login = `在终端运行 npx -y mcp-remote ${LINEAR_MCP_URL}，在打开的浏览器中授权 Linear，看到 Proxy established 后按 Ctrl-C，再点「重新检查」`;
  const base = { id: 'linear', label: 'Linear MCP：list_teams' };
  if (!linearLoggedIn()) {
    return {
      ...base,
      ok: false,
      detail: '~/.mcp-auth/mcp-remote-v1 中没有 Linear MCP 的 OAuth token（mcp-remote 未登录）',
      fix: login,
    };
  }
  const result = await attempt(() => callLinear('list_teams', {}, Teams));
  if (!result.ok) return { ...base, ok: false, detail: result.error, fix: login };
  const keys = result.value.teams.map((t) => t.key);
  if (!keys.includes(EVAL_TEAM)) {
    return {
      ...base,
      ok: false,
      detail: `${String(keys.length)} 个 team（${keys.join('、')}），没有评估用的 ${EVAL_TEAM}`,
      fix: `删除 ~/.mcp-auth/mcp-remote-v1 中 Linear 的 token，再用能访问 ${EVAL_TEAM} team 的账号授权：npx -y mcp-remote ${LINEAR_MCP_URL}`,
    };
  }
  return {
    ...base,
    ok: true,
    detail: `${String(keys.length)} 个 team，含 ${EVAL_TEAM}`,
    fix: login,
  };
}

// /review-pr 用的 Codex 模型：codex-models.txt 中第一个不是空行、不是注释的行
function reviewModel(txeWorkflowRepo: string): string {
  const file = path.join(txeWorkflowRepo, 'skills/review-pr/references/codex-models.txt');
  const model = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '' && !line.startsWith('#'));
  if (model === undefined) throw new Error(`${file} 中没有模型`);
  return model;
}

async function codexCheck(options: EnvironmentOptions): Promise<EnvironmentCheck> {
  const codexHome = path.join(options.workDir, 'codex-home');
  const cwd = path.join(options.workDir, 'codex-work');
  const base = { id: 'codex', label: 'Codex：独立 CODEX_HOME 下 codex exec' };
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
      fix: `运行 codex login 生成 ${options.codexAuthPath}，确认 ${options.codexConfigPath} 存在且是合法的 TOML，${options.txeWorkflowRepo}/skills/review-pr/references/codex-models.txt 中有模型`,
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
    ? '额度用完：恢复 ~/.codex/config.toml 中 model_provider 对应账号的额度，或改用有额度的 provider。'
    : /401|unauthorized|missing bearer|not logged in/i.test(result.output)
      ? '认证失败：运行 codex login 重新登录。'
      : '';
  return {
    ...base,
    ok,
    detail: ok
      ? `codex exec -m ${model} 返回 ${result.stdout.trim()}（${String(seconds)} 秒）`
      : result.output,
    fix: `${hint}在终端复现并按输出修复 ~/.codex/auth.json 或 ~/.codex/config.toml：${reproduce}`,
  };
}

async function vaultCheck(vaultDir: string, product: string): Promise<EnvironmentCheck> {
  const productDir = path.join(vaultDir, `Project ${product}`);
  const base = { id: 'vault', label: `Obsidian vault 与 Project ${product}/` };
  if (!fs.existsSync(vaultDir)) {
    return {
      ...base,
      ok: false,
      detail: `${vaultDir} 不存在`,
      fix: `在 Obsidian 中创建或打开 vault ${vaultDir}，然后运行 mkdir -p "${productDir}"`,
    };
  }
  const fix = `mkdir -p "${productDir}"（wf obsidian 要求 product 目录已存在）`;
  if (!fs.existsSync(productDir)) {
    return { ...base, ok: false, detail: `${productDir} 不存在`, fix };
  }
  const writable = await attempt(() => fs.promises.access(productDir, fs.constants.W_OK));
  if (!writable.ok)
    return { ...base, ok: false, detail: writable.error, fix: `chmod u+w "${productDir}"` };
  const features = path.join(productDir, 'Features');
  const runs = fs.existsSync(features) ? fs.readdirSync(features).length : 0;
  return {
    ...base,
    ok: true,
    detail: `${productDir} 可写，Features/ 下 ${String(runs)} 个目录`,
    fix,
  };
}

async function txeWorkflowCheck(repo: string): Promise<EnvironmentCheck> {
  const base = {
    id: 'txe-workflow',
    label: 'txe-workflow 仓库',
    fix: `git clone https://github.com/txehq/txe-workflow.git "${repo}"`,
  };
  const head = await command('git', ['-C', repo, 'log', '-1', '--format=%h %s']);
  if (!head.ok) return { ...base, ok: false, detail: head.output };
  const skills = path.join(repo, 'skills');
  if (!fs.existsSync(skills)) {
    return { ...base, ok: false, detail: `${skills} 不存在（HEAD ${head.stdout.trim()}）` };
  }
  const count = fs.readdirSync(skills).length;
  return {
    ...base,
    ok: true,
    detail: `${repo}，HEAD ${head.stdout.trim()}，${String(count)} 个 skill`,
  };
}

export async function runEnvironmentChecks(
  options: EnvironmentOptions,
): Promise<EnvironmentReport> {
  const models = options.models();
  const checks = await Promise.all([
    versionCheck(
      'claude',
      'claude 可执行',
      'claude',
      'npm install --global @anthropic-ai/claude-code，确认 claude 在 PATH 中',
    ),
    modelCheck('simulatedUser', models.simulatedUser),
    modelCheck('judge', models.judge),
    modelCheck('stageCheck', models.stageCheck),
    githubCheck(),
    linearCheck(),
    codexCheck(options),
    vaultCheck(options.vaultDir, options.product),
    txeWorkflowCheck(options.txeWorkflowRepo),
    versionCheck(
      'wf',
      'wf 可执行',
      'wf',
      '按 txe-workflow 的 README 安装 wf（在 Claude Code 中运行 /install），确认 ~/.local/bin 在 PATH 中',
    ),
    versionCheck('uv', 'uv 可执行', 'uv', 'curl -LsSf https://astral.sh/uv/install.sh | sh'),
    versionCheck(
      'ctx',
      'ctx 可执行',
      options.ctxBin,
      `运行 wf doctor，按 capso.ctx.binary 的提示修复（ctx 由 wf install 安装到 ${options.ctxBin}）`,
    ),
  ]);
  return { checkedAt: Date.now(), checks };
}

// 结果缓存 10 分钟；角色模型改变后（Settings 保存）下一次读取重新检查；同一时间只进行一次检查
export function createEnvironment(options: EnvironmentOptions) {
  let cached: { report: EnvironmentReport; modelsKey: string } | undefined;
  let inflight: Promise<EnvironmentReport> | undefined;

  function check(): Promise<EnvironmentReport> {
    inflight ??= (async () => {
      const modelsKey = JSON.stringify(options.models());
      const report = await runEnvironmentChecks(options).finally(() => {
        inflight = undefined;
      });
      cached = { report, modelsKey };
      return report;
    })();
    return inflight;
  }

  return {
    get(refresh: boolean): Promise<EnvironmentReport> {
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
