import { defineConfig } from 'vitest/config';

// 页面逻辑中不依赖浏览器的部分在 node 中测试
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
