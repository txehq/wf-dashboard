// 测 Sessions 页面上面三列的加载时间（Contracts 25.1：大目录下要快）：第一列、本机配置的第二列、session 最多的项目的第三列，
// 各读两次（第二次走按文件大小与修改时间的缓存），再读管理表格的第一页。只读磁盘上的元数据，不导入。
// 用法：pnpm --filter @wf-dashboard/server exec tsx scripts/measure-sessions-list.ts http://127.0.0.1:7332
import { z } from 'zod';

function serverUrl(): string {
  const url = process.argv[2];
  if (url === undefined) throw new Error('用法：measure-sessions-list.ts <服务端地址>');
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
  if (!res.ok) throw new Error(`${path} 返回 ${String(res.status)}：${await res.text()}`);
  return res.json();
}

for (const engine of ['claude', 'codex'] as const) {
  for (const pass of [1, 2]) {
    const { configs } = Configs.parse(
      await timed(`${engine} 第一列（第 ${String(pass)} 次）`, () =>
        json(`/api/session-import/configs?engine=${engine}`),
      ),
    );
    if (pass === 1)
      console.log(configs.map((c) => `${c.label} ${String(c.sessionCount)} 个`).join('，'));
    const page = Projects.parse(
      await timed(`${engine} 本机配置的第二列（第 ${String(pass)} 次）`, () =>
        json(`/api/session-import/projects?engine=${engine}&config=local&pageSize=100`),
      ),
    );
    const biggest = [...page.projects].sort((a, b) => b.sessionCount - a.sessionCount)[0];
    if (biggest === undefined) continue;
    const disk = Disk.parse(
      await timed(
        `${engine} 第三列：${biggest.name}（${String(biggest.sessionCount)} 个，第 ${String(pass)} 次）`,
        () =>
          json(
            `/api/session-import/sessions?engine=${engine}&config=local&cwd=${encodeURIComponent(biggest.cwd)}`,
          ),
      ),
    );
    if (pass === 1) console.log(`项目 ${String(page.total)} 个；第三列共 ${String(disk.total)} 个`);
  }
  await timed(`${engine} 管理表格第一页`, () => json(`/api/sessions?engine=${engine}&page=1`));
}
