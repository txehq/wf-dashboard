import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from '@decimalturn/toml-patch';
import { z } from 'zod';

// Keys of ~/.codex/config.toml written into CODEX_HOME (Contracts 7.10); other keys are not copied
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

// Write a temporary file, then rename it; mode 600
function writeAtomic(file: string, content: string | Buffer) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export interface CodexSources {
  // Login credentials, copied as is
  authPath: string;
  // Model and provider configuration (for example calls through a gateway)
  configPath: string;
}

// Writes Codex auth and model configuration into a separate CODEX_HOME: copies auth.json; takes only model keys
// from config.toml; copies the model_catalog_json file into CODEX_HOME and points to the copy. extra holds the
// caller's additional top-level keys (Codex draft session trust and update prompts, Contracts 17.3). Returns model and model_reasoning_effort
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
