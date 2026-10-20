import type { Page } from './test.js';

// 翻页或搜索后新的结果还没有到达的那段时间：拦下这个路由中带着这些参数的请求，直到调用返回的 release 才发给真实服务端。
// 只拦一次，之后的请求照常
export async function holdRequest(page: Page, pathname: string, params: Record<string, string>) {
  const gate: { open?: () => void } = {};
  const released = new Promise<void>((resolve) => {
    gate.open = resolve;
  });
  const held = (url: URL) =>
    url.pathname === pathname &&
    Object.entries(params).every(([key, value]) => url.searchParams.get(key) === value);
  await page.route(
    held,
    async (route) => {
      await released;
      await route.continue();
    },
    { times: 1 },
  );
  return () => {
    if (gate.open === undefined) throw new Error('拦下请求的 Promise 没有创建');
    gate.open();
  };
}
