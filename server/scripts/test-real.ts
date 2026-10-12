import { execa } from 'execa';

// pnpm test:real [文件…]：vitest 的 gateway 项目（真实档）。文件路径相对 server/ 或仓库根目录都可以；
// 不给文件时运行整个真实档
const files = process.argv.slice(2);
if (files.length === 0) console.log('运行整个真实档');
await execa('vitest', ['run', '--project', 'gateway', ...files], {
  preferLocal: true,
  stdio: 'inherit',
});
