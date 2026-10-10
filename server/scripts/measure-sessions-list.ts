// 测 Sessions 列表的加载时间：勾选 ~/.claude/projects 下全部目录并导入，再计时列表接口与翻页。
// 用法：pnpm --filter @wf-dashboard/server exec tsx scripts/measure-sessions-list.ts http://127.0.0.1:7316
import { z } from 'zod';

function serverUrl(): string {
  const url = process.argv[2];
  if (url === undefined) throw new Error('用法：measure-sessions-list.ts <服务端地址>');
  return url;
}
const base = serverUrl();

const Source = z.object({
  path: z.string(),
  variant: z.string().nullable(),
  sessionCount: z.number(),
});
const Page = z.object({
  sessions: z.array(z.object({ id: z.string(), requestCount: z.number() })),
  nextCursor: z.string().nullable(),
});

async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const value = await run();
  console.log(`${label}: ${String(Math.round(performance.now() - start))} ms`);
  return value;
}

async function json(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${base}${path}`, init);
  if (!res.ok) throw new Error(`${path} 返回 ${String(res.status)}：${await res.text()}`);
  return res.json();
}

const sources = z.array(Source).parse(await json('/api/sources'));
const home = sources.filter((s) => s.variant === null);
console.log(
  `来源目录 ${String(home.length)} 个，jsonl 合计 ${String(home.reduce((n, s) => n + s.sessionCount, 0))} 个`,
);

const imported = await timed('PUT /api/sources（勾选全部并导入）', () =>
  json('/api/sources', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths: home.map((s) => s.path) }),
  }),
);
console.log('导入结果', JSON.stringify((imported as { imported: unknown }).imported));

for (let i = 0; i < 3; i++) {
  await timed(`GET /api/sessions?limit=50 第 ${String(i + 1)} 次`, () =>
    json('/api/sessions?limit=50'),
  );
}

let cursor: string | null = null;
let total = 0;
let requests = 0;
let pages = 0;
const start = performance.now();
do {
  const query: string = cursor === null ? '' : `&cursor=${cursor}`;
  const page = Page.parse(await json(`/api/sessions?limit=50${query}`));
  total += page.sessions.length;
  requests += page.sessions.reduce((n, s) => n + s.requestCount, 0);
  pages += 1;
  cursor = page.nextCursor;
} while (cursor !== null);
console.log(
  `逐页读完全部：${String(pages)} 页、${String(total)} 个 session、${String(requests)} 次请求，${String(Math.round(performance.now() - start))} ms`,
);
await timed('GET /api/sessions?limit=500（一次读出全部）', () => json('/api/sessions?limit=500'));
