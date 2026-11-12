import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { createVariants } from '../src/variants/index.js';

// After refreshing the variant's auth, confirm codex is logged in within the variant environment and make one real call with the /review-pr model
// Usage: WFD_DATA_DIR=... tsx scripts/check-codex-auth.ts <variantId>
const id = process.argv[2];
if (id === undefined) throw new Error('Usage: tsx scripts/check-codex-auth.ts <variantId>');
const db = openDatabase(config.dbPath, config.migrationsDir);
const variants = createVariants({
  db,
  dataDir: config.dataDir,
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
});
variants.refreshAuthEnv(id);
const runtime = variants.runtimeEnv(id);
const env = { env: runtime.env, extendEnv: false } as const;
console.log(`CODEX_HOME=${runtime.env.CODEX_HOME}`);
const status = await execa('codex', ['login', 'status'], env);
console.log(status.stdout || status.stderr);

// The model the skill's codex exec uses: the first line in codex-models.txt that is neither blank nor a comment
const models = fs.readFileSync(
  path.join(runtime.env.CLAUDE_CONFIG_DIR, 'skills/review-pr/references/codex-models.txt'),
  'utf8',
);
const model = models
  .split('\n')
  .map((line) => line.trim())
  .find((line) => line !== '' && !line.startsWith('#'));
if (model === undefined) throw new Error('No model in codex-models.txt');
const cwd = path.join(runtime.env.TMPDIR, 'codex-check');
fs.mkdirSync(cwd, { recursive: true });
const exec = await execa(
  'codex',
  ['exec', '--skip-git-repo-check', '-m', model, '-s', 'read-only', 'Reply with exactly: pong'],
  { ...env, cwd, stdin: 'ignore' },
);
console.log(`codex exec -m ${model}: ${exec.stdout.trim()}`);
db.$client.close();
