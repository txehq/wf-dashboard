import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execa } from 'execa';
import treeKill from 'tree-kill';
import { z } from 'zod';
import type { AnalysisEngine, AnalysisTokens } from '../db/schema.js';

// Contracts 15.2: both engines run headless in a sandbox; tokens and cost come from the event stream

// An engine process's command line and environment (the part run inside sandbox-exec)
export interface EngineCommand {
  args: string[];
  env: Record<string, string>;
}

export interface EngineRunOptions {
  engine: AnalysisEngine;
  command: EngineCommand;
  // Analysis dir, the engine's cwd
  cwd: string;
  // CLAUDE_CONFIG_DIR or CODEX_HOME
  engineHome: string;
  // sandbox-exec profile
  profile: string;
  // The engine's stdout and stderr are written here as-is
  logFile: string;
  signal: AbortSignal;
  // Called once per event received, for progress
  onEvent: () => void;
}

export interface EngineResult {
  tokens: AnalysisTokens;
  // Null when Codex has no price
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

// The engine process gets only the env vars it needs, none inherited from the dashboard (which may hold CLAUDE*, ANTHROPIC*, ORCA_AGENT*)
function baseEnv(home: string): Record<string, string> {
  const env: Record<string, string> = { TMPDIR: path.join(home, 'tmp') };
  for (const key of ['HOME', 'PATH', 'USER', 'SHELL', 'LANG']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function engineCommand(o: {
  engine: AnalysisEngine;
  model: string;
  prompt: string;
  engineHome: string;
}): EngineCommand {
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
  // Codex's own Seatbelt cannot initialise nested in the outer sandbox (measured in W31); the outer sandbox limits file access
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
  const { args, env } = o.command;
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
    throw new Error(`${o.engine} did not start: ${String((await child).originalMessage)}`);
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
        errors.push(
          `claude ended with ${result.subtype}: ${result.result ?? JSON.stringify(event)}`,
        );
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
        // Codex's input_tokens include cache reads and writes (measured in W31); like Claude, count only the uncached part
        const cacheWrite = u.cache_write_input_tokens ?? 0;
        tokens.input += u.input_tokens - u.cached_input_tokens - cacheWrite;
        tokens.output += u.output_tokens;
        tokens.cacheRead += u.cached_input_tokens;
        tokens.cacheWrite += cacheWrite;
        tokens.reasoning += u.reasoning_output_tokens;
      } else if (parsed.type === 'turn.failed') {
        errors.push(
          `codex turn.failed: ${z.looseObject({ message: z.string() }).parse(parsed.error).message}`,
        );
      } else if (parsed.type === 'error') {
        errors.push(`codex error: ${z.string().parse(parsed.message)}`);
      }
    }
  }
  const result = await child;
  o.signal.removeEventListener('abort', kill);
  log.end();
  o.signal.throwIfAborted();
  if (result.exitCode !== 0) {
    throw new Error(
      `${o.engine} exit code ${String(result.exitCode ?? result.signal)}: ${errors.join('\n')}\n${stderr.trim()}`,
    );
  }
  if (errors.length > 0) throw new Error(errors.join('\n'));
  if (!finished) {
    throw new Error(`${o.engine} produced no final event: ${stderr.trim()}`);
  }
  return { tokens, costUsd };
}
