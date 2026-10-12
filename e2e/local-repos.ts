import path from 'node:path';

// e2e 各服务的本地仓库模式目录（Contracts 7.2）：run 与交互的仓库建为这里的 bare 仓库，e2e 不在 GitHub 上建仓库
export const e2eLocalReposDir = path.resolve(import.meta.dirname, '../.work/e2e/repos');
