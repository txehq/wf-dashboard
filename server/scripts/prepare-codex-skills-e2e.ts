import path from 'node:path';
import { makeSkillSources } from '../test/helpers/codex-skills.js';

// e2e 的 Codex 草稿（Contracts 第 17 节）：npx skills add 的来源换成 .work/e2e/codex-skills/ 下的本地 git 仓库，
// 由 e2e/services.ts 经 WFD_CODEX_SKILL_SOURCES 交给服务端；e2e 不依赖网络
const dir = path.resolve(import.meta.dirname, '../../.work/e2e/codex-skills');
const sources = makeSkillSources(dir);
console.log(`Codex 草稿的 skill 来源：${sources.map((s) => s.source).join('、')}`);
