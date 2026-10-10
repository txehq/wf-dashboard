import path from 'node:path';
import { defineConfig } from 'vitest/config';

// 页面逻辑中不依赖浏览器的部分在 node 中测试；@ 指向 src，与 vite.config.ts 相同
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
