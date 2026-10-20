import { expect, type Locator, type Page } from './test.js';

// Compare 的 e2e（compare-*.spec.ts，project compare）共用的准备与定位。
// 数据由 server/scripts/seed-compare-e2e.ts 写入专用数据目录：
// 基线与 "interview 追问边界" 两个 variant × lfg-calculator 与 ic-money-format × 每格 3 次，
// 另有一次有人工干预的基线 lfg run、一次读取了基线 ic run 仓库的 ic run，以及只试跑过一次 lfg 的第三个 variant。
// 页面的选择都在页面状态中，不写服务端，几个文件可以同时运行

// 页面截取视口（选择区与分数表）；某一节截取该节的完整内容。截图前等改选后的数据加载完
export const shot = async (target: Page | Locator, name: string) => {
  const page = 'page' in target ? target.page() : target;
  await expect(page.getByTestId('compare-body')).toHaveAttribute('data-refreshing', 'false');
  await target.screenshot({ path: `.work/screenshots/w11-${name}.png`, animations: 'disabled' });
};
export const sectionOf = (page: Page, title: string) =>
  page.locator('section', { has: page.getByRole('heading', { level: 2, name: title }) });

export const lfgRow = (page: Page) => page.getByTestId('score-row-lfg-calculator');
export const icRow = (page: Page) => page.getByTestId('score-row-ic-money-format');

// 对比范围是一个有评测类型的 workflow（Contracts 16.5），默认是 /lfg
export const chooseScope = async (page: Page, scope: string) => {
  await page.getByTestId('compare-scope').getByRole('radio', { name: scope }).check();
  await expect(page.getByTestId('compare-body')).toHaveAttribute('data-refreshing', 'false');
};

// 每个用例开始前（beforeEach）：打开 Compare，等分数表出现
export const openCompare = async (page: Page) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/compare');
  await expect(page.getByRole('heading', { level: 1, name: 'Compare' })).toBeVisible();
  await expect(page.getByTestId('score-table')).toBeVisible();
};

export function breakdownCaption(section: ReturnType<Page['locator']>, text: string) {
  return section.getByTestId('cost-breakdown').locator('figcaption', { hasText: text });
}
