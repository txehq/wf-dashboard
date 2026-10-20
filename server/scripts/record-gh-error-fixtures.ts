import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { format, resolveConfig } from 'prettier';
import { config } from '../src/config.js';

// 录下环境检查中 gh 失败时的真实输出：test/fixtures/gh-errors/<名字>.json 记 kind 与环境检查依次运行的每条 gh 命令
// （args、exitCode、output），测试中由 test/fixtures/gh-errors/bin/gh 按参数回放。gh 在 .work/ 下隔离的 GH_CONFIG_DIR 中
// 运行，不碰本机真实的 gh 配置；只读取 GitHub。TLS 握手超时无法在本机稳定造出，用 2026-10-13 用户实例环境检查中
// 真实出现的那一次（tls-handshake-timeout.json，按当时的输出手工录入）。
// 运行：pnpm --filter @wf-dashboard/server record:gh-error-fixtures
const fixtures = path.join(config.repoRoot, 'server/test/fixtures/gh-errors');
const configDir = path.join(config.repoRoot, '.work/gh-error-fixtures/config');
const badToken = `ghp_${'0'.repeat(36)}`;
// 环境检查（src/environment.ts 的 githubCheck）在这两条都成功后才查组织成员
const commands = [
  ['auth', 'status'],
  ['api', 'user', '--jq', '.login'],
];

const cases: {
  name: string;
  kind: 'auth' | 'network' | 'other';
  env: Record<string, string>;
  hostsYml?: string;
}[] = [
  { name: 'not-logged-in', kind: 'auth', env: {} },
  { name: 'bad-credentials', kind: 'auth', env: { GH_TOKEN: badToken } },
  // 代理端口上没有服务：连接被拒
  {
    name: 'connection-refused',
    kind: 'network',
    env: { GH_TOKEN: badToken, HTTPS_PROXY: 'http://127.0.0.1:9' },
  },
  // 代理的域名解析不到
  {
    name: 'dns-failure',
    kind: 'network',
    env: { GH_TOKEN: badToken, HTTPS_PROXY: 'http://nonexistent.invalid:8080' },
  },
  // gh 的配置文件损坏
  { name: 'invalid-config', kind: 'other', env: {}, hostsYml: 'hosts: [\n' },
];

const writeJson = async (file: string, value: unknown) => {
  const options = await resolveConfig(file);
  fs.writeFileSync(file, await format(JSON.stringify(value), { ...options, filepath: file }));
};

fs.mkdirSync(fixtures, { recursive: true });
for (const c of cases) {
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.mkdirSync(configDir, { recursive: true });
  if (c.hostsYml !== undefined) fs.writeFileSync(path.join(configDir, 'hosts.yml'), c.hostsYml);
  const env: Record<string, string | undefined> = {
    ...process.env,
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GH_CONFIG_DIR: configDir,
    ...c.env,
  };
  const recorded = [];
  for (const args of commands) {
    const result = await execa('gh', args, {
      env,
      extendEnv: false,
      reject: false,
      stdin: 'ignore',
      all: true,
    });
    if (result.exitCode === 0)
      throw new Error(`${c.name}：gh ${args.join(' ')} 没有失败：${result.all}`);
    recorded.push({ args, exitCode: result.exitCode, output: result.all });
    console.log(
      `${c.name}（${c.kind}）gh ${args.join(' ')} exit ${String(result.exitCode)}：${result.all}`,
    );
  }
  await writeJson(path.join(fixtures, `${c.name}.json`), {
    kind: c.kind,
    commands: recorded,
    recordedAt: new Date().toISOString(),
  });
}
fs.rmSync(path.dirname(configDir), { recursive: true, force: true });
