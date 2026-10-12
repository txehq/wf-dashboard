import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from '@decimalturn/toml-patch';
import { z } from 'zod';

// ~/.codex/config.toml 中写进 CODEX_HOME 的键（Contracts 7.10）；其余键不复制
const CODEX_CONFIG_KEYS = [
  'model',
  'model_provider',
  'model_reasoning_effort',
  'model_providers',
] as const;

const CodexConfig = z.looseObject({
  model: z.string().optional(),
  model_provider: z.string().optional(),
  model_reasoning_effort: z.string().optional(),
  model_catalog_json: z.string().optional(),
  model_providers: z.record(z.string(), z.looseObject({})).optional(),
});

// 先写临时文件再 rename，权限 600
function writeAtomic(file: string, content: string | Buffer) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export interface CodexSources {
  // 登录凭据，原样复制
  authPath: string;
  // 模型与 provider 配置（例如经 gateway 调用）
  configPath: string;
}

// 把 Codex 的认证与模型配置写进一个独立的 CODEX_HOME：复制 auth.json；从 config.toml 只取模型相关的键，
// model_catalog_json 指向的文件复制进 CODEX_HOME 并改写为副本的路径。extra 是调用方另加的顶层键
// （Codex 草稿会话的信任与更新提示，Contracts 17.3）。返回写入的 model 与 model_reasoning_effort
export function writeCodexHome(
  codexHome: string,
  { authPath, configPath }: CodexSources,
  extra: Record<string, unknown> = {},
): { model: string | null; effort: string | null } {
  fs.mkdirSync(codexHome, { recursive: true });
  writeAtomic(path.join(codexHome, 'auth.json'), fs.readFileSync(authPath));
  const source = CodexConfig.parse(parse(fs.readFileSync(configPath, 'utf8')));
  const picked: Record<string, unknown> = {};
  for (const key of CODEX_CONFIG_KEYS) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  if (source.model_catalog_json !== undefined) {
    const catalog = path.resolve(path.dirname(configPath), source.model_catalog_json);
    const copy = path.join(codexHome, path.basename(catalog));
    writeAtomic(copy, fs.readFileSync(catalog));
    picked.model_catalog_json = copy;
  }
  writeAtomic(path.join(codexHome, 'config.toml'), stringify({ ...picked, ...extra }));
  return { model: source.model ?? null, effort: source.model_reasoning_effort ?? null };
}
