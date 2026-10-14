import path from 'node:path';
import { createMagiRepo } from '../test/helpers/magi-repo.js';

// Magi Agent 的基础档 e2e：在给定目录建一个本地 git 仓库作为"主仓库"（main 分支，agent/MAGI.md，没有依赖的 pnpm
// 工作区）。worktree 由服务第一次打开时建在它旁边，不碰真实的主仓库与 wf-dashboard-magi-agent
const [dir] = process.argv.slice(2);
if (dir === undefined) throw new Error('用法：tsx scripts/prepare-magi-agent-e2e.ts <仓库目录>');
await createMagiRepo(path.resolve(dir));
console.log(`Magi Agent 的 e2e 主仓库：${dir}`);
