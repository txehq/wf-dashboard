import { config } from '../../src/config.js';
import { vaultCheck } from '../../src/environment.js';
import { launchSpec } from '../../src/runs/prepare.js';
import { isolatedBaseEnv } from '../../src/variants/claude-config.js';

// 在新进程中按当时的 MAGI_VAULT 读取 config（服务启动时只读一次），打印 vault 的位置、来源、环境检查一项，
// 以及传给 agent 的 MAGI_VAULT：run 的启动环境与 Live、Magi Agent 共用的子进程环境
const runtime = {
  env: {
    CLAUDE_CONFIG_DIR: '/c',
    WF_HOME: '/w',
    CODEX_HOME: '/x',
    TMPDIR: '/t',
    PATH: '/p',
  },
  mcpConfigPath: '/m.json',
  claudeArgs: [],
  sessionsDir: '/s',
};
const launch = launchSpec(
  runtime,
  { id: 'r-probe', model: 'sonnet', effort: 'low' },
  { prepare: ['vault-dir'] },
  { vaultDir: config.vaultDir, product: config.evalProduct },
);
console.log(
  JSON.stringify({
    vaultDir: config.vaultDir,
    vaultSource: config.vaultSource,
    check: await vaultCheck(config.vaultDir, config.vaultSource, config.evalProduct),
    runEnv: launch.env.MAGI_VAULT,
    agentEnv: isolatedBaseEnv().MAGI_VAULT,
  }),
);
