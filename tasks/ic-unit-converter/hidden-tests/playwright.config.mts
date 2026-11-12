import net from 'node:net';
import path from 'node:path';

// Hidden test config for grading. During grading this file is copied outside the checkout and the command's cwd is the checkout,
// so the project root is process.cwd(); the checkout's node_modules cannot be resolved from outside it, so only Node built-ins are used

const root = process.cwd();

// The free port is picked once in the runner process and inherited by workers via the environment; concurrent gradings each get their own
async function freePort(): Promise<string> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Could not get a port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return String(address.port);
}

process.env.WF_HIDDEN_PORT ??= await freePort();
const baseURL = `http://127.0.0.1:${process.env.WF_HIDDEN_PORT}`;

export default {
  // testDir is the repo root so JUnit classnames are paths relative to the repo root
  testDir: root,
  testMatch: 'test/hidden/**/*.spec.ts',
  outputDir: path.join(root, 'test-results', 'hidden'),
  retries: 0,
  fullyParallel: true,
  workers: 4,
  // Missing controls make actions wait, so timeouts are short and failures on the starting repo end quickly
  timeout: 15_000,
  expect: { timeout: 3_000 },
  use: { baseURL, actionTimeout: 3_000, browserName: 'chromium', headless: true },
  webServer: {
    command: `npx vite build --outDir dist-hidden --emptyOutDir && npx vite preview --outDir dist-hidden --host 127.0.0.1 --port ${process.env.WF_HIDDEN_PORT} --strictPort`,
    cwd: root,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
};
