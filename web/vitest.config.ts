import { availableParallelism } from 'node:os';
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
    // 同时运行的测试文件最多为本机核数的一半：web 的测试只要 7 秒左右，W92 在 8 核上实测 4 个时测试进程树自身的
    // 1 分钟 load 最高 0.2，远低于 pnpm check 的上限 4
    maxWorkers: Math.max(1, Math.floor(availableParallelism() / 2)),
    projects: [
      {
        extends: true,
        test: { name: 'node', include: ['src/**/*.test.ts'], environment: 'node' },
      },
      {
        extends: true,
        // 测试中途才发现的依赖会让 Vite 重新预构建并重新加载页面、打断正在运行的测试。这里关闭发现，
        // 只预构建下面列出的依赖：漏列的 CommonJS 依赖在导入时以原文失败（例如没有 default 导出），
        // 不会在测试中途重新加载
        optimizeDeps: {
          noDiscovery: true,
          include: [
            '@iconify-icons/logos/claude-icon',
            '@iconify-icons/logos/openai-icon',
            '@iconify/react',
            '@monaco-editor/react',
            '@tanstack/react-query',
            '@tanstack/react-virtual',
            '@xterm/addon-fit',
            '@xterm/xterm',
            '@xyflow/react',
            'class-variance-authority',
            'diff',
            // 经 server 的 schema 导入，从 server 包解析
            '@wf-dashboard/server > drizzle-orm',
            '@wf-dashboard/server > drizzle-orm/sqlite-core',
            'hast-util-to-string',
            'highlight.js/lib/common',
            'lucide-react',
            'mermaid',
            'monaco-editor',
            'radix-ui',
            'react',
            'react-diff-view',
            'react-dom',
            'react-dom/client',
            'react-markdown',
            'react-router',
            'react-router/dom',
            'react/jsx-dev-runtime',
            'recharts',
            'rehype-highlight',
            'rehype-raw',
            'rehype-sanitize',
            'rehype-slug',
            'remark-frontmatter',
            'remark-gfm',
            'yaml',
            'zod',
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
