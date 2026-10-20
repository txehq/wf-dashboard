import { expect, type Page, test } from './test.js';
import { z } from 'zod';

// Sessions 列表的固定宽度与 Session 详情头部（Contracts 18.1、18.2），用导入的 W4 run（prepare-runs-e2e）：
// ic run a26chw（仓库、PR、工单 TXE-3788）与 lfg run dqva52（feature 目录中的文档）
const icSession = 'ba7cdc89-21ef-4b94-83aa-05073ed3d25f';
const lfgSession = '0188c133-3e7b-4592-a963-fc717cf283de';
const shots = '.work/screenshots';

// 表格不横向滚动，标题与目录两列合计不超过 35%；单元格中的内容不伸出单元格：放不下的截断（overflow hidden），
// 截断处悬停显示全文（title）
async function checkLayout(page: Page) {
  const table = page.getByTestId('session-table');
  await expect(page.getByTestId('session-row').first()).toBeVisible();
  const measured = await table.evaluate((el) => {
    const width = el.getBoundingClientRect().width;
    const col = (key: string) => {
      const c = el.querySelector(`col[data-column="${key}"]`);
      if (c === null) throw new Error(`没有 ${key} 列`);
      return c.getBoundingClientRect().width;
    };
    const spilling: string[] = [];
    const untitled: string[] = [];
    for (const cell of el.querySelectorAll('td')) {
      const box = cell.getBoundingClientRect();
      for (const child of cell.querySelectorAll('*')) {
        const r = child.getBoundingClientRect();
        if (r.right > box.right + 1 || r.left < box.left - 1) spilling.push(cell.textContent);
      }
      for (const node of [cell, ...cell.querySelectorAll('*')]) {
        if (node.scrollWidth <= node.clientWidth + 1) continue;
        if (getComputedStyle(node).overflowX !== 'hidden') spilling.push(node.textContent);
        else if (node.closest('[title]') === null) untitled.push(node.textContent);
      }
    }
    const doc = document.documentElement;
    const widths = [...el.querySelectorAll('col')].map((c) => ({
      key: c.getAttribute('data-column'),
      width: c.getBoundingClientRect().width,
    }));
    const titles = [...el.querySelectorAll('[data-testid="session-row"] a')].map(
      (a) => a.getClientRects().length === 1 && getComputedStyle(a).whiteSpace === 'nowrap',
    );
    return {
      width,
      parent: el.parentElement?.clientWidth ?? 0,
      titleAndCwd: (col('title') + col('cwd')) / width,
      widest: widths.reduce((a, b) => (b.width > a.width ? b : a)).key,
      singleLineTitles: titles.every(Boolean),
      spilling,
      untitled,
      pageScroll: doc.scrollWidth - doc.clientWidth,
    };
  });
  expect(measured.width).toBeLessThanOrEqual(measured.parent);
  expect(measured.titleAndCwd).toBeLessThanOrEqual(0.35 + 0.001);
  // 标题是最宽的一列，一行截断
  expect(measured.widest).toBe('title');
  expect(measured.singleLineTitles).toBe(true);
  expect(measured.spilling).toEqual([]);
  expect(measured.untitled).toEqual([]);
  expect(measured.pageScroll).toBe(0);
}

for (const width of [1280, 1600]) {
  test(`Sessions 列表 ${String(width)} 宽：不横向滚动，标题与目录不超过 35%，没有"交互"标记，每行有 Live`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/sessions');
    await checkLayout(page);
    await expect(page.getByTestId('session-table').getByTestId('live-badge')).toHaveCount(0);
    const rows = page.getByTestId('session-row');
    await expect(rows.first().getByTestId('open-in-live')).toBeVisible();
    expect(await rows.getByTestId('open-in-live').count()).toBe(await rows.count());
    // Live 是图标按钮，悬停显示说明
    await expect(rows.first().getByTestId('open-in-live')).toHaveAttribute(
      'title',
      '在 Live 中打开',
    );
    await expect(rows.first().getByTestId('open-in-live')).toHaveAccessibleName('在 Live 中打开');
    // run 的 session 在 variant 一列的第二行显示 run
    await expect(
      page.locator(`[data-session="${icSession}"]`).getByTestId('session-run'),
    ).toHaveText('r-20261009-a26chw');
    // 截断的标题悬停显示全文
    const title = rows.first().getByRole('link');
    expect(await title.getAttribute('title')).toBe(await title.textContent());
    await page.screenshot({ path: `${shots}/w43-sessions-${String(width)}.png` });
  });
}

const Session = z.object({ cwd: z.string(), variant: z.object({ id: z.string() }) });

test('Session 详情头部：没有 resume，工作区与 variant 是链接，"绑定的对象"列出 GitHub、Linear 与 Obsidian', async ({
  page,
}) => {
  const ic = Session.parse(await (await page.request.get(`/api/sessions/${icSession}`)).json());
  await page.goto(`/sessions/${icSession}`);
  const summary = page.getByTestId('session-summary');
  await expect(summary.getByTestId('open-in-live')).toBeVisible();
  await expect(summary.getByTestId('resume-open')).toHaveCount(0);
  await expect(summary.getByTestId('session-workspace')).toHaveText(ic.cwd);
  await expect(summary.getByTestId('session-variant-link')).toHaveAttribute(
    'href',
    `/variants/${ic.variant.id}`,
  );
  await page.screenshot({ path: `${shots}/w43-detail-header.png` });

  await summary.getByTestId('session-links-open').click();
  const links = page.getByTestId('session-links');
  const repo = 'https://github.com/txehq/wfe-r-20261009-a26chw';
  await expect(
    links.getByRole('link', { name: 'txehq/wfe-r-20261009-a26chw', exact: true }),
  ).toHaveAttribute('href', repo);
  await expect(links.getByRole('link', { name: 'txehq/wfe-r-20261009-a26chw#1' })).toHaveAttribute(
    'href',
    `${repo}/pull/1`,
  );
  await expect(links.getByRole('link', { name: 'TXE-3788' })).toHaveAttribute(
    'href',
    /^https:\/\/linear\.app\/capso\/issue\/TXE-3788\//,
  );
  await page.screenshot({ path: `${shots}/w43-bindings-ic.png` });

  await page.goto(`/sessions/${lfgSession}`);
  await page.getByTestId('session-summary').getByTestId('session-links-open').click();
  // 导入的 run 记录中产物的位置（W4 运行时那台机器上的 vault），不随服务端的 MAGI_VAULT 变化
  const brief = encodeURIComponent('/Project Magi Eval/Features/r-20261009-dqva52/Brief.md');
  const briefLink = page.getByTestId('session-links').getByRole('link', { name: 'Brief.md' });
  await expect(briefLink).toHaveAttribute(
    'href',
    new RegExp(`^obsidian://open\\?path=%2F.+${brief.replace(/[.]/g, '\\.')}$`),
  );
  expect(await briefLink.getAttribute('href')).not.toContain(
    encodeURIComponent(String(process.env.MAGI_VAULT)),
  );
  await page.screenshot({ path: `${shots}/w43-bindings.png` });
});
