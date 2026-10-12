import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { serverPort, webPort } from '../ports';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy: {
      // ws：交互区的终端经 WebSocket 连接 /api/live/:id/pty
      '/api': { target: `http://127.0.0.1:${String(serverPort)}`, ws: true },
    },
  },
});
