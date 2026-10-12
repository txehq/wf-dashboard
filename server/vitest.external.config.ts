import { defineConfig } from 'vitest/config';

// 真实在 Linear 的 Workflow Eval project 建工单的集成测试；工单全部保留。GitHub 只读取，创建或修改对象的 gh 命令报错
export default defineConfig({
  test: {
    include: ['test/**/*.external.test.ts'],
    setupFiles: ['test/setup/data-dir.ts'],
    globalSetup: ['test/setup/data-guard.ts', 'test/setup/github-guard.ts'],
  },
});
