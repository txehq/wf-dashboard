import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

// 基础档（pnpm test 的 local 项目、pnpm e2e）不调用真实模型、claude 与 Codex：
// PATH 最前面放 test/setup/basic-bin 中会报错的 claude 与 codex，调用记在 .work/basic-tier/blocked.log；
// gateway 认证的来源换成一份副本，其中 ANTHROPIC_BASE_URL 指向不存在的域名，模型请求在 DNS 解析时失败。
// 只设置一次，子进程与 Playwright 的 worker 继承
const bin = path.resolve(import.meta.dirname, 'basic-bin');
const work = path.resolve(import.meta.dirname, '../../../.work/basic-tier');
export const blockedLog = path.join(work, 'blocked.log');
export const blockedGateway = 'http://gateway-forbidden-in-basic-tier.invalid';

const Settings = z.looseObject({ env: z.looseObject({ ANTHROPIC_BASE_URL: z.string() }) });

export function guardBasicTier() {
  if (process.env.WFD_BASIC_TIER_LOG !== undefined) return;
  const source = path.resolve(
    process.env.WFD_CLAUDE_SETTINGS ?? path.join(os.homedir(), '.claude/settings.json'),
  );
  const settings = Settings.parse(JSON.parse(fs.readFileSync(source, 'utf8')));
  settings.env.ANTHROPIC_BASE_URL = blockedGateway;
  // 各 vitest worker 都写同一份内容：先写到自己的文件再改名，读取方不会读到写了一半的文件
  const copy = path.join(work, 'settings.json');
  const partial = path.join(work, `settings.${String(process.pid)}.json`);
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(partial, JSON.stringify(settings, null, 2));
  fs.renameSync(partial, copy);
  process.env.WFD_CLAUDE_SETTINGS = copy;
  process.env.WFD_BASIC_TIER_LOG = blockedLog;
  process.env.PATH = `${bin}${path.delimiter}${String(process.env.PATH)}`;
}
