import { config } from '../../src/config.js';
import { localRepos, type RunRepos } from '../../src/external/run-repos.js';

// 测试中 run 与交互的仓库：本地仓库模式（Contracts 7.2），目录由 test/setup/data-dir.ts 设在 .work/ 下
export function testRepos(): RunRepos {
  if (config.localReposDir === null) {
    throw new Error('测试没有在本地仓库模式下运行：WFD_LOCAL_REPOS_DIR 未设置');
  }
  return localRepos(config.localReposDir);
}
