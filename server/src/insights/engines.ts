import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execa } from 'execa';
import treeKill from 'tree-kill';
import { z } from 'zod';
import type { AnalysisEngine, AnalysisTokens } from '../db/schema.js';

// Contracts 15.2：两种引擎在 sandbox 中 headless 运行，从事件流中取 token 与花费

export interface EngineRunOptions {
  engine: AnalysisEngine;
  model: string;
  // 分析目录，引擎的 cwd
  cwd: string;
  prompt: string;
  // CLAUDE_CONFIG_DIR 或 CODEX_HOME
  engineHome: string;
  // sandbox-exec 的 profile
  profile: string;
  // 引擎的 stdout 与 stderr 原样写到这里
  logFile: string;
  signal: AbortSignal;
  // 每收到一个事件调用一次，用于进度
  onEvent: () => void;
}

export interface EngineResult {
  tokens: AnalysisTokens;
  // Codex 没有价格时为空
  costUsd: number | null;
}

const ClaudeResult = z.looseObject({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().optional(),
  total_cost_usd: z.number(),
  usage: z.looseObject({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_read_input_tokens: z.number(),
    cache_creation_input_tokens: z.number(),
  }),
});

const CodexUsage = z.looseObject({
  input_tokens: z.number(),
  cached_input_tokens: z.number(),
  cache_write_input_tokens: z.number().optional(),
  output_tokens: z.number(),
  reasoning_output_tokens: z.number(),
});

const CodexEvent = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('turn.completed'), usage: CodexUsage }),
  z.looseObject({ type: z.literal('turn.failed'), error: z.looseObject({ message: z.string() }) }),
  z.looseObject({ type: z.literal('error'), message: z.string() }),
  z.looseObject({
    type: z.enum([
      'thread.started',
      'turn.started',
      'item.started',
      'item.updated',
      'item.completed',
    ]),
  }),
]);

const emptyTokens = (): AnalysisTokens => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
});

// 引擎进程只拿到运行需要的环境变量，不继承 dashboard 的（其中可能有 CLAUDE*、ANTHROPIC*、ORCA_AGENT*）
function baseEnv(home: string): Record<string, string> {
  const env: Record<string, string> = { TMPDIR: path.join(home, 'tmp') };
  for (const key of ['HOME', 'PATH', 'USER', 'SHELL', 'LANG']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function commandOf(o: EngineRunOptions): { args: string[]; env: Record<string, string> } {
  if (o.engine === 'claude') {
    return {
      args: [
        'claude',
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'bypassPermissions',
        '--model',
        o.model,
        o.prompt,
      ],
      env: { ...baseEnv(o.engineHome), CLAUDE_CONFIG_DIR: o.engineHome },
    };
  }
  // Codex 自己的 Seatbelt 不能嵌套在外层 sandbox 中初始化（W31 实测），文件访问的限制由外层 sandbox 负责
  return {
    args: [
      'codex',
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-s',
      'danger-full-access',
      '-m',
      o.model,
      o.prompt,
    ],
    env: { ...baseEnv(o.engineHome), CODEX_HOME: o.engineHome },
  };
}

export async function runEngine(o: EngineRunOptions): Promise<EngineResult> {
  o.signal.throwIfAborted();
  const { args, env } = commandOf(o);
  fs.mkdirSync(path.join(o.engineHome, 'tmp'), { recursive: true });
  const log = fs.createWriteStream(o.logFile, { flags: 'a' });
  const child = execa('sandbox-exec', ['-p', o.profile, ...args], {
    cwd: o.cwd,
    env,
    extendEnv: false,
    reject: false,
    stdin: 'ignore',
    buffer: false,
  });
  const pid = child.pid;
  if (pid === undefined)
    throw new Error(`${o.engine} 没有启动：${String((await child).originalMessage)}`);
  const kill = () => {
    treeKill(pid, 'SIGKILL', (error) => {
      if (error !== undefined) throw error;
    });
  };
  o.signal.addEventListener('abort', kill, { once: true });

  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    log.write(chunk);
    stderr = (stderr + chunk.toString('utf8')).slice(-8_000);
  });
  const tokens = emptyTokens();
  let costUsd: number | null = null;
  let finished = false;
  const errors: string[] = [];
  for await (const line of readline.createInterface({ input: child.stdout })) {
    log.write(`${line}\n`);
    if (line.trim() === '') continue;
    const event: unknown = JSON.parse(line);
    o.onEvent();
    if (o.engine === 'claude') {
      const type = z.looseObject({ type: z.string() }).parse(event).type;
      if (type !== 'result') continue;
      const result = ClaudeResult.parse(event);
      finished = true;
      if (result.is_error || result.subtype !== 'success') {
        errors.push(`claude 以 ${result.subtype} 结束：${result.result ?? JSON.stringify(event)}`);
      }
      tokens.input += result.usage.input_tokens;
      tokens.output += result.usage.output_tokens;
      tokens.cacheRead += result.usage.cache_read_input_tokens;
      tokens.cacheWrite += result.usage.cache_creation_input_tokens;
      costUsd = (costUsd ?? 0) + result.total_cost_usd;
    } else {
      const parsed = CodexEvent.parse(event);
      if (parsed.type === 'turn.completed') {
        finished = true;
        const u = CodexUsage.parse(parsed.usage);
        // Codex 的 input_tokens 含缓存读与缓存写（W31 实测），与 Claude 一致地只记未缓存的部分
        const cacheWrite = u.cache_write_input_tokens ?? 0;
        tokens.input += u.input_tokens - u.cached_input_tokens - cacheWrite;
        tokens.output += u.output_tokens;
        tokens.cacheRead += u.cached_input_tokens;
        tokens.cacheWrite += cacheWrite;
        tokens.reasoning += u.reasoning_output_tokens;
      } else if (parsed.type === 'turn.failed') {
        errors.push(
          `codex turn.failed：${z.looseObject({ message: z.string() }).parse(parsed.error).message}`,
        );
      } else if (parsed.type === 'error') {
        errors.push(`codex error：${z.string().parse(parsed.message)}`);
      }
    }
  }
  const result = await child;
  o.signal.removeEventListener('abort', kill);
  log.end();
  o.signal.throwIfAborted();
  if (result.exitCode !== 0) {
    throw new Error(
      `${o.engine} 退出码 ${String(result.exitCode ?? result.signal)}：${errors.join('\n')}\n${stderr.trim()}`,
    );
  }
  if (errors.length > 0) throw new Error(errors.join('\n'));
  if (!finished) {
    throw new Error(`${o.engine} 没有输出结束事件：${stderr.trim()}`);
  }
  return { tokens, costUsd };
}
