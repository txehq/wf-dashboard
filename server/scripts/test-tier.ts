import { execa } from 'execa';

// pnpm test:real [文件…] 与 pnpm test:slow [文件…]：vitest 的 gateway 项目（真实档）与 slow 项目（慢档）。
// 文件路径相对 server/ 或仓库根目录都可以；不给文件时运行整档
const tiers = {
  real: { project: 'gateway', name: '真实档' },
  slow: { project: 'slow', name: '慢档' },
};
const [tier, ...files] = process.argv.slice(2);
if (tier !== 'real' && tier !== 'slow')
  throw new Error(`第一个参数必须是 real 或 slow：${String(tier)}`);
const { project, name } = tiers[tier];
if (files.length === 0) console.log(`运行整个${name}`);
await execa('vitest', ['run', '--project', project, ...files], {
  preferLocal: true,
  stdio: 'inherit',
});
