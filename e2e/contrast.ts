import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { blend, parse, wcagContrast } from 'culori';
import { expect, type Locator, type Page } from './test.js';

// 明暗两种主题下的对比度检查（WCAG AA）：文字用 axe-core 的 color-contrast 规则（正文 4.5:1、大字 3:1）；
// 色带、logo 这类非文字的标记用 nonTextContrast（3:1）。页面用根元素的 dark 类切换主题（index.css 的变量）
export const themes = ['light', 'dark'] as const;
export type Theme = (typeof themes)[number];

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, '.work/screenshots');
const records = path.join(root, '.work/contrast');
const sizes = [
  { width: 1280, height: 800 },
  { width: 1600, height: 1000 },
] as const;

export async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.evaluate((dark) => {
    document.documentElement.classList.toggle('dark', dark);
  }, theme === 'dark');
  // 颜色的过渡动画结束、mermaid 与 Monaco 换好主题后再检查
  await page.waitForTimeout(400);
}

interface NodeData {
  fgColor?: string;
  bgColor?: string;
  contrastRatio?: number;
  expectedContrastRatio?: string;
  fontSize?: string;
  fontWeight?: string;
}

// 一个页面（当前的状态）在两种主题下各检查一次，不达标的元素写进 .work/contrast/<name>.json 并让用例失败（soft，
// 同一个用例中的其余页面照常检查）；screenshot 为 true 时两种主题、两种窗口各截一张 w55-<name>-<主题>-<宽>.png
export async function checkContrast(
  page: Page,
  name: string,
  options: { screenshot?: boolean; include?: string } = {},
): Promise<void> {
  const failures: string[] = [];
  const recorded: Record<string, unknown[]> = {};
  for (const theme of themes) {
    await setTheme(page, theme);
    let builder = new AxeBuilder({ page }).withRules(['color-contrast']);
    if (options.include !== undefined) builder = builder.include(options.include);
    const result = await builder.analyze();
    const nodes = result.violations.flatMap((v) => v.nodes);
    recorded[theme] = nodes.map((node) => ({
      target: node.target,
      html: node.html.slice(0, 200),
      ...(node.any[0]?.data as NodeData | undefined),
    }));
    // axe 判断不了的元素（背景是图片、渐变或被其他元素盖住）另记一份，供人工看截图
    recorded[`${theme}-incomplete`] = result.incomplete
      .flatMap((v) => v.nodes)
      .map((node) => ({ target: node.target, html: node.html.slice(0, 200) }));
    for (const node of nodes) {
      const data = node.any[0]?.data as NodeData | undefined;
      failures.push(
        `${theme} ${node.target.join(' ')}：${String(data?.fgColor)} / ${String(data?.bgColor)} = ${String(data?.contrastRatio)}（需要 ${String(data?.expectedContrastRatio)}）`,
      );
    }
    if (options.screenshot === true) {
      const original = page.viewportSize();
      for (const size of sizes) {
        await page.setViewportSize(size);
        await page.screenshot({
          path: path.join(shots, `w55-${name}-${theme}-${String(size.width)}.png`),
          animations: 'disabled',
        });
      }
      if (original !== null) await page.setViewportSize(original);
    }
  }
  await setTheme(page, 'light');
  mkdirSync(records, { recursive: true });
  writeFileSync(path.join(records, `${name}.json`), `${JSON.stringify(recorded, null, 2)}\n`);
  expect.soft(failures, `${name} 的对比度`).toEqual([]);
}

// 非文字标记与它所在的底色的对比度（WCAG 1.4.11，3:1）：color 取标记的某个 CSS 属性，底色从元素向上找第一个
// 不透明的背景，半透明的背景按层叠合成
export async function nonTextContrast(
  marker: Locator,
  property: 'background-color' | 'fill' | 'color' | 'border-left-color',
  backgroundOf: Locator,
): Promise<number> {
  const color = await marker.evaluate(
    (el, prop) => getComputedStyle(el).getPropertyValue(prop),
    property,
  );
  const layers = await backgroundOf.evaluate((el) => {
    const found: string[] = [];
    for (let node: Element | null = el; node !== null; node = node.parentElement) {
      found.push(getComputedStyle(node).backgroundColor);
    }
    return found;
  });
  // 从浏览器的白色画布、最外层向内层叠合成
  const backdrop = blend(['white', ...layers.reverse()]);
  const fg = parse(color);
  if (fg === undefined) throw new Error(`无法解析颜色：${color}`);
  return wcagContrast(blend([backdrop, fg]), backdrop);
}
