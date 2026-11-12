// Measure the load time of the top three columns of the Sessions page (Contracts 25.1: fast on large directories): the first column, the second column for the local config, the third column for the project with the most sessions,
// each read twice (the second hits the cache keyed by file size and mtime), then the first page of the management table. Reads only on-disk metadata, no import.
// Usage: pnpm --filter @wf-dashboard/server exec tsx scripts/measure-sessions-list.ts http://127.0.0.1:7332
import { z } from 'zod';

function serverUrl(): string {
  const url = process.argv[2];
  if (url === undefined) throw new Error('Usage: measure-sessions-list.ts <server url>');
  return url;
}
const base = serverUrl();

const Configs = z.object({
  configs: z.array(z.object({ id: z.string(), label: z.string(), sessionCount: z.number() })),
});
const Projects = z.object({
  projects: z.array(z.object({ cwd: z.string(), name: z.string(), sessionCount: z.number() })),
  total: z.number(),
});
const Disk = z.object({ sessions: z.array(z.object({ id: z.string() })), total: z.number() });

async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const value = await run();
  console.log(`${label}: ${String(Math.round(performance.now() - start))} ms`);
  return value;
}

async function json(path: string): Promise<unknown> {
  const res = await fetch(`${base}${path}`);
  if (!res.ok) throw new Error(`${path} returned ${String(res.status)}: ${await res.text()}`);
  return res.json();
}

for (const engine of ['claude', 'codex'] as const) {
  for (const pass of [1, 2]) {
    const { configs } = Configs.parse(
      await timed(`${engine} first column (pass ${String(pass)})`, () =>
        json(`/api/session-import/configs?engine=${engine}`),
      ),
    );
    if (pass === 1)
      console.log(configs.map((c) => `${c.label} ${String(c.sessionCount)}`).join(', '));
    const page = Projects.parse(
      await timed(`${engine} second column for the local config (pass ${String(pass)})`, () =>
        json(`/api/session-import/projects?engine=${engine}&config=local&pageSize=100`),
      ),
    );
    const biggest = [...page.projects].sort((a, b) => b.sessionCount - a.sessionCount)[0];
    if (biggest === undefined) continue;
    const disk = Disk.parse(
      await timed(
        `${engine} third column: ${biggest.name} (${String(biggest.sessionCount)} sessions, pass ${String(pass)})`,
        () =>
          json(
            `/api/session-import/sessions?engine=${engine}&config=local&cwd=${encodeURIComponent(biggest.cwd)}`,
          ),
      ),
    );
    if (pass === 1)
      console.log(`${String(page.total)} projects; ${String(disk.total)} in the third column`);
  }
  await timed(`${engine} management table first page`, () =>
    json(`/api/sessions?engine=${engine}&page=1`),
  );
}
