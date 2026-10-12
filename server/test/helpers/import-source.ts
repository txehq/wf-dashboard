// 导入测试的 GitHub 源仓库：已存在的 txehq/txe-workflow，只读取（克隆、读 commit 与 workflow）。
// 固定的两个 commit：9f2bed6 有 ci.yml（pull_request、workflow_dispatch）与 release.yml（push、workflow_dispatch），
// e2b9ac9 是它的父 commit
export const IMPORT_SOURCE = {
  repo: 'txehq/txe-workflow',
  commit: '9f2bed6fbdcef9e30a9a773a95bc5a9d618016ff',
  parent: 'e2b9ac90617f7a03690664b441b4b93d1ef4b7cd',
  // 9f2bed6 之前（含）的 commit 数
  commits: 60,
};

// 没有 .github/workflows 的已存在仓库（只有一个 commit），只读取
export const NO_WORKFLOW_SOURCE = {
  repo: 'txehq/docker-node-awscli',
  commit: 'a33dd96235924477e93b33cb4511c9badd7e2457',
};
