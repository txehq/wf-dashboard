import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

// The pure computation tests of Contracts 38.1: stage splitting, Linear stats, session import and cost refresh
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Half the machine's cores run test files at once: typecheck, lint and vitest run side by side in pnpm check
    maxWorkers: Math.max(1, Math.floor(availableParallelism() / 2)),
    // Each test process's data directory is .work/test-data/<pid>/; before and after the run, data/ at the repo root must gain nothing
    setupFiles: ['test/setup/data-dir.ts'],
    globalSetup: ['test/setup/data-guard.ts'],
  },
});
