import fs from 'node:fs';
import path from 'node:path';

// 基础档（pnpm test 的 local 项目、pnpm e2e）与慢档不调用真实模型、claude 与 Codex：
// PATH 最前面放 test/setup/basic-bin 中会报错的 claude 与 codex，调用记在 .work/basic-tier/blocked.log，
// 与只记下参数的 open；
// gateway 认证的来源（WFD_CLAUDE_SETTINGS）换成基础档自己的 settings.json：ANTHROPIC_BASE_URL 指向不存在的域名，
// 模型请求在 DNS 解析时失败；凭据是占位的文字，模型别名是当前的模型名。Codex 认证与配置的来源（WFD_CODEX_AUTH、
// WFD_CODEX_CONFIG）同样换成基础档自己的 auth.json（占位的 key）与 config.toml（模型与 effort）。
// 不读本机的 ~/.claude/settings.json 与 ~/.codex，没有登录 Claude Code 与 Codex 的机器上也能运行。
// offline（基础档）：基础档不依赖网络，再放 basic-bin/offline 中会报错的 gh。
// 只设置一次，子进程与 Playwright 的 worker 继承
const bin = path.resolve(import.meta.dirname, 'basic-bin');
const offlineBin = path.join(bin, 'offline');
const work = path.resolve(import.meta.dirname, '../../../.work/basic-tier');
export const blockedLog = path.join(work, 'blocked.log');
// basic-bin 中的 open 把参数记在这里（"在访达中打开"不真的打开访达）
export const openLog = path.join(work, 'open.log');
export const blockedGateway = 'http://gateway-forbidden-in-basic-tier.invalid';

const settings = {
  env: {
    ANTHROPIC_BASE_URL: blockedGateway,
    ANTHROPIC_AUTH_TOKEN: 'basic-tier-no-token',
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5-1[1m]',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5[1m]',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5-5[1m]',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-5-5[1m]',
  },
};
const codexAuth = { auth_mode: 'apikey', OPENAI_API_KEY: 'basic-tier-no-key' };
const codexConfig = 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n';

// 各 vitest worker 都写同一份内容：先写到自己的文件再改名，读取方不会读到写了一半的文件
function writeShared(name: string, content: string): string {
  const file = path.join(work, name);
  const partial = path.join(work, `${String(process.pid)}.${name}`);
  fs.writeFileSync(partial, content);
  fs.renameSync(partial, file);
  return file;
}

export function guardBasicTier({ offline }: { offline: boolean }) {
  if (process.env.WFD_BASIC_TIER_LOG !== undefined) return;
  fs.mkdirSync(work, { recursive: true });
  process.env.WFD_CLAUDE_SETTINGS = writeShared('settings.json', JSON.stringify(settings, null, 2));
  process.env.WFD_CODEX_AUTH = writeShared('auth.json', JSON.stringify(codexAuth, null, 2));
  process.env.WFD_CODEX_CONFIG = writeShared('config.toml', codexConfig);
  process.env.WFD_BASIC_TIER_LOG = blockedLog;
  process.env.PATH = [...(offline ? [offlineBin] : []), bin, String(process.env.PATH)].join(
    path.delimiter,
  );
}
