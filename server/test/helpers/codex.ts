import { config } from '../../src/config.js';
import { codexStandIn } from './codex-skills.js';

// createLive 的 codex 依赖：bin 默认是替身命令，认证与模型配置来自 config
export function testCodex(bin = codexStandIn) {
  return {
    bin,
    sources: { authPath: config.codexAuthPath, configPath: config.codexConfigPath },
    sessionTimeoutMs: 30_000,
  };
}
