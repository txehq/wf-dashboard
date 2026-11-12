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
      // ws: the workspace terminal connects to /api/live/:id/pty over WebSocket
      '/api': { target: `http://127.0.0.1:${String(serverPort)}`, ws: true },
    },
  },
  // vite preview serves the build output with the same port and /api proxy as the dev server
  preview: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${String(serverPort)}`, ws: true },
    },
  },
});
