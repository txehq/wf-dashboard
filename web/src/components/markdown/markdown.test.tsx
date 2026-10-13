import { StrictMode } from 'react';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';
import { must } from '@/lib/must';
import { Markdown } from './markdown';

const skill = `---
name: ic
description: 'From a ticket to a PR'
allowed-tools:
  - Read
  - Bash
---

# Contract

See [the checklist](references/checklist.md), the [parent](../README.md) and [Contract](#contract).
Visit https://example.com for more[^1]. ~~Old wording~~

| Step | Skill |
| ---- | ----- |
| 1    | claim |
| 2    | implement |

- [x] read the ticket
- [ ] open the \`PR\`

\`\`\`ts
const answer: number = 42;
\`\`\`

\`\`\`mermaid
flowchart LR
  claim --> implement --> review
\`\`\`

![diagram](assets/flow.png)

<script>window.__pwned = 'script'</script>
<img src="https://example.com/x.png" onerror="window.__pwned = 'onerror'" alt="outside">
<a href="javascript:window.__pwned = 'href'" onclick="window.__pwned = 'onclick'">click</a>
<details><summary>More</summary>hidden text</details>

[^1]: A footnote.
`;

const texts = (root: Element, selector: string) =>
  [...root.querySelectorAll(selector)].map((e) => e.textContent.trim());

test('GFM、frontmatter 表格、代码高亮、mermaid 与 GitHub 的渲染一致', async () => {
  const screen = await render(
    <Markdown
      content={skill}
      filePath="skills/ic/SKILL.md"
      fileHref={(path) => `/open?file=${path}`}
      imageSrc={(path) => `/raw/${path}`}
    />,
  );
  const article = screen.container.querySelector('article.markdown-body');
  if (article === null) throw new Error('没有渲染出 article');

  // frontmatter：键是表头，值在下一行，列表在单元格中再放一张表
  const frontmatter = article.querySelector('table.frontmatter');
  if (frontmatter === null) throw new Error('没有 frontmatter 表格');
  expect(texts(frontmatter, ':scope > thead th')).toEqual(['name', 'description', 'allowed-tools']);
  expect(texts(frontmatter, ':scope > tbody > tr > td').slice(0, 2)).toEqual([
    'ic',
    'From a ticket to a PR',
  ]);
  expect(texts(frontmatter, ':scope > tbody > tr > td table td')).toEqual(['Read', 'Bash']);
  expect(article.textContent).not.toContain('allowed-tools:');

  // GFM：表格、任务列表、删除线、自动链接、脚注
  const table = must(
    article.querySelectorAll('table:not(.frontmatter):not(.frontmatter table)')[0],
  );
  expect(texts(table, 'th')).toEqual(['Step', 'Skill']);
  expect(texts(table, 'tbody tr')).toEqual(['1claim', '2implement']);
  const boxes = [...article.querySelectorAll<HTMLInputElement>('li.task-list-item input')];
  expect(boxes.map((b) => [b.type, b.checked, b.disabled])).toEqual([
    ['checkbox', true, true],
    ['checkbox', false, true],
  ]);
  expect(texts(article, 'del')).toEqual(['Old wording']);
  const auto = article.querySelector('a[href="https://example.com"]');
  expect(auto?.getAttribute('target')).toBe('_blank');
  expect(texts(article, 'section[data-footnotes] li')[0]).toContain('A footnote.');
  expect(article.querySelector('sup a')?.getAttribute('href')).toBe('#fn-1');
  expect(article.querySelector('section[data-footnotes] li')?.id).toBe('user-content-fn-1');
  expect(article.querySelector('h1')?.id).toBe('user-content-contract');

  // 代码高亮
  const code = must(article.querySelector('pre code.language-ts'));
  expect(code.classList.contains('hljs')).toBe(true);
  expect(texts(code, '.hljs-keyword')).toEqual(['const']);
  expect(texts(code, '.hljs-number')).toEqual(['42']);

  // mermaid 渲染成图
  await expect.element(screen.getByTestId('mermaid')).toHaveAttribute('data-rendered', 'true');
  const svg = article.querySelector('[data-testid="mermaid"] svg');
  expect(svg).not.toBeNull();
  expect(svg?.textContent).toContain('implement');
  expect(article.textContent).not.toContain('flowchart LR');

  // 相对链接与图片按所在文件解析
  expect(
    [...article.querySelectorAll('a[data-file]')].map((a) => [
      a.getAttribute('data-file'),
      a.getAttribute('href'),
    ]),
  ).toEqual([
    ['skills/ic/references/checklist.md', '/open?file=skills/ic/references/checklist.md'],
    ['skills/README.md', '/open?file=skills/README.md'],
  ]);
  expect(article.querySelector('img[data-file]')?.getAttribute('src')).toBe(
    '/raw/skills/ic/assets/flow.png',
  );
  expect(article.querySelector('details summary')?.textContent).toBe('More');
});

test('内容中的脚本与内联事件被去掉，不执行', async () => {
  const screen = await render(<Markdown content={skill} filePath="skills/ic/SKILL.md" />);
  const article = screen.container.querySelector('article.markdown-body');
  if (article === null) throw new Error('没有渲染出 article');
  expect(article.querySelector('script')).toBeNull();
  expect(article.innerHTML).not.toContain('__pwned');
  const outside = article.querySelector('img[alt="outside"]');
  expect(outside?.getAttribute('src')).toBe('https://example.com/x.png');
  expect(outside?.hasAttribute('onerror')).toBe(false);
  const link = [...article.querySelectorAll('a')].find((a) => a.textContent === 'click');
  expect(link?.hasAttribute('href')).toBe(false);
  expect(link?.hasAttribute('onclick')).toBe(false);
  // 外部图片加载失败后也没有执行 onerror
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect((window as unknown as { __pwned?: string }).__pwned).toBeUndefined();
  // 没有给出文件地址时，相对链接不可跳转，图片显示为说明文字
  expect(article.querySelector('a[data-file]')?.hasAttribute('href')).toBe(false);
  expect(article.querySelector('.md-image-path')?.textContent).toBe('diagram');
});

test('YAML 有错的 frontmatter 显示为 yaml 代码块', async () => {
  const screen = await render(<Markdown content={'---\nname: [unclosed\n---\n\ntext\n'} />);
  expect(screen.container.querySelector('table')).toBeNull();
  expect(screen.container.querySelector('pre code.language-yaml')?.textContent).toContain(
    'name: [unclosed',
  );
});

test('mermaid 语法有错时显示原文与代码', async () => {
  const screen = await render(<Markdown content={'```mermaid\nflowchart LR\n  a --\n```\n'} />);
  await expect.element(screen.getByTestId('mermaid-error')).toBeVisible();
  expect(screen.container.querySelector('[data-testid="mermaid-error"] code')?.textContent).toBe(
    'flowchart LR\n  a --\n',
  );
});

test('同一页面中两份相同的 mermaid 图都显示（渲染后的对比的左右两侧）', async () => {
  const content = '```mermaid\nflowchart LR\n  A[列出] --> B[扫描]\n```\n';
  const screen = await render(
    <StrictMode>
      <Markdown content={content} />
      <Markdown content={content} />
    </StrictMode>,
  );
  const diagrams = screen.container.querySelectorAll('[data-testid="mermaid"]');
  expect(diagrams).toHaveLength(2);
  await expect
    .poll(() => screen.container.querySelectorAll('[data-testid="mermaid"] > svg').length)
    .toBe(2);
  const ids = [...screen.container.querySelectorAll('[data-testid="mermaid"] > svg')].map(
    (svg) => svg.id,
  );
  expect(new Set(ids).size).toBe(2);
});

test('源文件中改动的行所在的段落被标出：段落、列表中的一项、表格中的一行', async () => {
  const lines = skill.split('\n');
  const lineOf = (text: string) => lines.findIndex((l) => l.includes(text)) + 1;
  const screen = await render(
    <Markdown
      content={skill}
      marks={{
        kind: 'added',
        lines: [
          [lineOf('| 2 '), lineOf('| 2 ')],
          // 这一项中有行内代码：标出的是整项
          [lineOf('open the `PR`'), lineOf('open the `PR`')],
          [lineOf('# Contract'), lineOf('# Contract')],
        ],
      }}
    />,
  );
  const marked = [...screen.container.querySelectorAll('.md-mark-added')];
  expect(marked.map((e) => [e.tagName, e.textContent.trim()])).toEqual([
    ['H1', 'Contract'],
    ['TR', '2implement'],
    ['LI', 'open the PR'],
  ]);
  expect(getComputedStyle(must(marked[0])).backgroundColor).toBe('rgb(230, 255, 236)');
});

test('列表的符号：无序为圆点、有序为数字、任务列表没有符号', async () => {
  const screen = await render(<Markdown content={'- a\n\n1. b\n\n- [ ] c\n'} />);
  const styles = [...screen.container.querySelectorAll('ul, ol')].map(
    (list) => getComputedStyle(list).listStyleType,
  );
  expect(styles).toEqual(['disc', 'decimal', 'none']);
});

test('明暗两种主题随页面', async () => {
  const screen = await render(<Markdown content={'# title\n\n```ts\nconst a = 1;\n```\n'} />);
  const article = screen.container.querySelector('article.markdown-body');
  const keyword = screen.container.querySelector('.hljs-keyword');
  if (article === null || keyword === null) throw new Error('没有渲染');
  expect(getComputedStyle(article).backgroundColor).toBe('rgb(255, 255, 255)');
  expect(getComputedStyle(keyword).color).toBe('rgb(207, 34, 46)');
  document.documentElement.classList.add('dark');
  expect(getComputedStyle(article).backgroundColor).toBe('rgb(13, 17, 23)');
  expect(getComputedStyle(keyword).color).toBe('rgb(255, 123, 114)');
  document.documentElement.classList.remove('dark');
});
