import { expect, type Page, test } from './test.js';
import { analysisWorkflowServerPort } from '../ports.js';
import { checkContrast, nonTextContrast, setTheme, themes } from './contrast.js';

// Live 列表中每项一眼能看出用途与引擎（Contracts 14.3），基础档。用 analysis-workflow 的数据（这个 project 在它之后运行）：
// 导入一轮的短 session cfa31f10（交互，Claude Code）；新建一个 workflow 的 Codex 草稿与 secret-keeper 的 variant 草稿
// （设计，Codex）；把那次成功的分析交给 Codex 优化（优化，Codex）。Codex 是替身命令，不调用模型
const api = `http://127.0.0.1:${String(analysisWorkflowServerPort)}/api`;
const shots = '.work/screenshots';
const session = 'cfa31f10-e280-4908-bcf7-cbe9b00fbe53';

interface Item {
  id: string;
  claudeSessionId: string | null;
}
const ids = { interaction: '', designWorkflow: '', designVariant: '', optimize: '' };
let analysisId = '';

test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

test.beforeAll(async ({ request }) => {
  const list = (await (await request.get(`${api}/live?includeHidden=true`)).json()) as Item[];
  const existing = list.find((l) => l.claudeSessionId === session);
  if (existing === undefined) {
    const imported = await request.post(`${api}/live/import`, { data: { sessionIds: [session] } });
    expect(imported.status()).toBe(201);
    ids.interaction = ((await imported.json()) as Item[])[0]?.id ?? '';
  } else {
    ids.interaction = existing.id;
    await request.post(`${api}/live/${existing.id}/unhide`);
  }
  const workflowDraft = await request.post(`${api}/workflow-drafts`, {
    data: {
      mode: 'workflow',
      engine: 'codex',
      workflowId: `w53-${String(Date.now())}`,
      name: 'W53 新 workflow',
      description: '',
      requirement: '一个两阶段的小流程',
    },
  });
  expect(workflowDraft.status()).toBe(201);
  ids.designWorkflow = ((await workflowDraft.json()) as { live: Item }).live.id;
  const variants = (await (await request.get(`${api}/variants`)).json()) as {
    id: string;
    workflowId: string;
  }[];
  const base = variants.find((v) => v.workflowId === 'secret-keeper');
  if (base === undefined) throw new Error('测试数据中没有 secret-keeper 的 variant');
  const variantDraft = await request.post(`${api}/workflow-drafts`, {
    data: {
      mode: 'variant',
      engine: 'codex',
      workflowId: 'secret-keeper',
      requirement: '回答更短',
      baseVariantId: base.id,
    },
  });
  expect(variantDraft.status()).toBe(201);
  ids.designVariant = ((await variantDraft.json()) as { live: Item }).live.id;
  const analyses = (await (await request.get(`${api}/analyses`)).json()) as {
    id: string;
    status: string;
  }[];
  analysisId = analyses.find((a) => a.status === 'succeeded')?.id ?? '';
  const optimized = await request.post(`${api}/analyses/${analysisId}/optimize`, {
    data: { engine: 'codex' },
  });
  expect(optimized.status()).toBe(201);
  ids.optimize = ((await optimized.json()) as { live: Item }).live.id;
});

test.afterAll(async ({ request }) => {
  // 结束 Codex 替身的进程（准备完成后启动）
  for (const id of [ids.designWorkflow, ids.designVariant, ids.optimize]) {
    const stopped = await request.post(`${api}/live/${id}/stop`);
    expect([200, 409]).toContain(stopped.status());
  }
});

const itemOf = (page: Page, id: string) =>
  page.getByTestId('live-list').locator(`[data-live="${id}"]`);

async function expectIdentity(
  page: Page,
  id: string,
  purpose: string,
  label: string,
  engine: string,
) {
  const item = itemOf(page, id);
  await expect(item).toHaveAttribute('data-purpose', purpose);
  await expect(item.getByTestId('live-purpose-band')).toHaveAttribute('data-purpose', purpose);
  await expect(item.getByTestId('live-purpose')).toHaveText(label);
  await expect(item.getByRole('img', { name: engine })).toHaveAttribute('title', engine);
}

test('三种用途各自的色带、标签与 logo；优化的标签链接到分析；明暗两种主题与两种窗口', async ({
  page,
}) => {
  await page.goto('/live');
  await page.evaluate(() => {
    localStorage.removeItem('live.purposeFilter');
  });
  await page.reload();
  await expectIdentity(page, ids.interaction, 'interaction', '交互', 'Claude Code');
  await expectIdentity(page, ids.designWorkflow, 'design', '设计 workflow', 'Codex');
  await expectIdentity(page, ids.designVariant, 'design', '设计 variant', 'Codex');
  await expectIdentity(page, ids.optimize, 'optimize', '优化', 'Codex');
  await expect(itemOf(page, ids.optimize).getByTestId('live-purpose')).toHaveAttribute(
    'href',
    `/analyses/${analysisId}`,
  );
  // 不只靠颜色：三种色带的颜色各不相同，标签上有文字
  const colors = await Promise.all(
    [ids.interaction, ids.designWorkflow, ids.optimize].map((id) =>
      itemOf(page, id)
        .getByTestId('live-purpose-band')
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    ),
  );
  expect(new Set(colors).size).toBe(3);
  for (const [width, height] of [
    [1280, 800],
    [1600, 1000],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `${shots}/w53-list-light-${String(width)}.png` });
    await page.evaluate(() => {
      document.documentElement.classList.add('dark');
    });
    await page.screenshot({ path: `${shots}/w53-list-dark-${String(width)}.png` });
    // 暗色下色带仍然各不相同；OpenAI 的标志（路径本身的填充色）跟随文字颜色，与背景不同、不是黑色
    const dark = await Promise.all(
      [ids.interaction, ids.designWorkflow, ids.optimize].map((id) =>
        itemOf(page, id)
          .getByTestId('live-purpose-band')
          .evaluate((el) => getComputedStyle(el).backgroundColor),
      ),
    );
    expect(new Set(dark).size).toBe(3);
    const logo = await itemOf(page, ids.optimize)
      .getByRole('img', { name: 'Codex' })
      .evaluate((el) => {
        const pathEl = el.querySelector('path');
        if (pathEl === null) throw new Error('logo 中没有路径');
        return { fill: getComputedStyle(pathEl).fill, text: getComputedStyle(el).color };
      });
    expect(logo.fill).toBe(logo.text);
    expect(logo.fill).not.toBe('rgb(0, 0, 0)');
    await page.evaluate(() => {
      document.documentElement.classList.remove('dark');
    });
  }
});

test('按用途筛选，刷新后保持', async ({ page }) => {
  await page.goto('/live');
  const filter = page.getByTestId('live-purpose-filter');
  await filter.getByRole('radio', { name: /设计/ }).click();
  await expect(itemOf(page, ids.designWorkflow)).toBeVisible();
  await expect(itemOf(page, ids.designVariant)).toBeVisible();
  await expect(itemOf(page, ids.interaction)).toHaveCount(0);
  await expect(itemOf(page, ids.optimize)).toHaveCount(0);
  await page.screenshot({ path: `${shots}/w53-filter-design.png` });
  await page.reload();
  await expect(filter.getByRole('radio', { name: /设计/ })).toHaveAttribute('aria-checked', 'true');
  await expect(itemOf(page, ids.interaction)).toHaveCount(0);
  await filter.getByRole('radio', { name: /优化/ }).click();
  await expect(itemOf(page, ids.optimize)).toBeVisible();
  await expect(itemOf(page, ids.designWorkflow)).toHaveCount(0);
  await filter.getByRole('radio', { name: /全部/ }).click();
  await expect(itemOf(page, ids.interaction)).toBeVisible();
});

test('标签页标题与全屏中的切换下拉显示用途的颜色与引擎的 logo', async ({ page }) => {
  await page.goto(`/live?tabs=${ids.interaction},${ids.optimize}&item=${ids.optimize}`);
  const tab = (id: string) => page.locator(`[data-testid="live-tab"][data-live="${id}"]`);
  await expect(tab(ids.interaction).getByRole('img', { name: 'Claude Code' })).toBeVisible();
  await expect(tab(ids.interaction).getByTestId('live-purpose-band')).toHaveAttribute(
    'data-purpose',
    'interaction',
  );
  await expect(tab(ids.optimize).getByRole('img', { name: 'Codex' })).toBeVisible();
  await expect(tab(ids.optimize).getByTestId('live-purpose-band')).toHaveAttribute(
    'data-purpose',
    'optimize',
  );
  await page.screenshot({ path: `${shots}/w53-tabs.png` });

  await page.getByTestId('fullscreen-toggle').click();
  const switcher = page.getByTestId('live-switcher');
  await expect(switcher.getByRole('img', { name: 'Codex' })).toBeVisible();
  await switcher.click();
  const option = page.locator(`[data-testid="live-switcher-item"][data-live="${ids.interaction}"]`);
  await expect(option.getByRole('img', { name: 'Claude Code' })).toBeVisible();
  await expect(option.getByTestId('live-purpose-band')).toHaveAttribute(
    'data-purpose',
    'interaction',
  );
  await expect(option).toContainText('交互');
  await page.screenshot({ path: `${shots}/w53-fullscreen-switcher.png` });
  await option.click();
  await expect(page.getByTestId('live-panel')).toHaveAttribute('data-live', ids.interaction);
  await expect(page.getByTestId('live-fullscreen')).toHaveAttribute('data-fullscreen', 'true');
});

test('对比度：列表、交互项、全屏与切换下拉的文字达到 WCAG AA；色带与 logo 与底色至少 3:1（明暗两种主题）', async ({
  page,
}) => {
  await page.goto(`/live?tabs=${ids.interaction},${ids.optimize}&item=${ids.interaction}`);
  await expectIdentity(page, ids.optimize, 'optimize', '优化', 'Codex');
  await checkContrast(page, 'live-list', { screenshot: true });
  for (const theme of themes) {
    await setTheme(page, theme);
    for (const id of [ids.interaction, ids.designWorkflow, ids.optimize]) {
      const item = itemOf(page, id);
      const band = item.getByTestId('live-purpose-band');
      expect(
        await nonTextContrast(band, 'background-color', item),
        `${theme} ${id} 的色带`,
      ).toBeGreaterThanOrEqual(3);
    }
    for (const [id, engine] of [
      [ids.interaction, 'Claude Code'],
      [ids.optimize, 'Codex'],
    ] as const) {
      const item = itemOf(page, id);
      const logoPath = item.getByRole('img', { name: engine }).locator('path').first();
      expect(
        await nonTextContrast(logoPath, 'fill', item),
        `${theme} ${engine} 的 logo`,
      ).toBeGreaterThanOrEqual(3);
    }
  }
  await setTheme(page, 'light');

  await page.goto(`/live?item=${ids.optimize}`);
  await expect(page.getByTestId('live-panel')).toHaveAttribute('data-live', ids.optimize);
  await checkContrast(page, 'live-codex-item', { screenshot: true });

  await page.goto(`/live?item=${ids.interaction}&fullscreen=1`);
  await expect(page.getByTestId('live-fullscreen')).toHaveAttribute('data-fullscreen', 'true');
  await page.getByTestId('live-switcher').click();
  await expect(page.getByTestId('live-switcher-item').first()).toBeVisible();
  await checkContrast(page, 'live-fullscreen-switcher', { screenshot: true });
});
