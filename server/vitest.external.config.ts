import { defineConfig } from 'vitest/config';

// 真实创建 Linear 工单与 txehq 仓库的集成测试；对象全部保留
export default defineConfig({
  test: {
    include: ['test/**/*.external.test.ts'],
  },
});
