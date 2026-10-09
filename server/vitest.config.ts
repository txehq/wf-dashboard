import { defineConfig } from 'vitest/config';

// *.external.test.ts 会在 Linear 与 txehq 中创建对象，只由 test:external 运行
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.external.test.ts'],
  },
});
