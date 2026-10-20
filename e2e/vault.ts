import path from 'node:path';

// e2e 各服务的 Obsidian vault（Contracts 第 30 节）：不读用户的 MAGI_VAULT，run 与交互的产物写到这里
export const e2eVaultDir = path.resolve(import.meta.dirname, '../.work/e2e/vault');
