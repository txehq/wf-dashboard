import path from 'node:path';
import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// 页面逻辑中不依赖浏览器的部分（*.test.ts）在 node 中测试；组件（*.test.tsx）在真实的 Chromium 中渲染后测试。
// @ 指向 src，与 vite.config.ts 相同
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'node', include: ['src/**/*.test.ts'], environment: 'node' },
      },
      {
        extends: true,
        // 测试中途才发现的依赖会让 Vite 重新加载页面、打断测试，这里先列出
        optimizeDeps: {
          include: [
            'diff',
            'hast-util-to-string',
            'lucide-react',
            'mermaid',
            'react-diff-view',
            'react-markdown',
            'rehype-highlight',
            'rehype-raw',
            'rehype-sanitize',
            'rehype-slug',
            'remark-frontmatter',
            'remark-gfm',
            'yaml',
          ],
        },
        test: {
          name: 'browser',
          include: ['src/**/*.test.tsx'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
            screenshotFailures: false,
          },
        },
      },
    ],
  },
});
