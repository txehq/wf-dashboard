import type { Element } from 'hast';
import { toString } from 'hast-util-to-string';
import { memo, type MouseEvent, useRef } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeSlug from 'rehype-slug';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import { remarkFrontmatterTable } from './frontmatter';
import { type LineMarks, rehypeMarkLines } from './mark-lines';
import { MermaidDiagram } from './mermaid';
import './theme';

// GitHub 的白名单（rehype-sanitize 的默认规则），另允许 frontmatter 表格的 class
const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    table: [...(defaultSchema.attributes?.table ?? []), ['className', 'frontmatter']],
  },
};

// sanitize 给 id 加的前缀，避免内容中的 id 与页面的冲突
const ID_PREFIX = 'user-content-';

const hasScheme = (url: string) => /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//');

// 相对路径按所在文件解析，得到相对根目录的路径
function resolvePath(filePath: string, target: string): string {
  const base = `file:///${filePath.split('/').map(encodeURIComponent).join('/')}`;
  return decodeURIComponent(new URL(target, base).pathname.slice(1));
}

// react-markdown 传给组件的 node（hast 节点）不是 DOM 属性
function domProps<T extends { node?: unknown }>(props: T): Omit<T, 'node'> {
  const copy = { ...props };
  delete copy.node;
  return copy;
}

const mermaidCode = (pre: Element | undefined): string | null => {
  const code = pre?.children.find((child) => child.type === 'element');
  if (code?.tagName !== 'code') return null;
  const classes = code.properties.className;
  if (!Array.isArray(classes) || !classes.includes('language-mermaid')) return null;
  return toString(code);
};

export interface MarkdownProps {
  content: string;
  // 这份内容所在文件的路径：相对链接与图片按它解析
  filePath?: string | undefined;
  // 指向其他文件的链接：地址，与点击时的动作（不给动作时按地址跳转）
  fileHref?: ((path: string) => string) | undefined;
  onOpenFile?: ((path: string) => void) | undefined;
  // 相对路径的图片的地址
  imageSrc?: ((path: string) => string) | undefined;
  // 源文件中要标出的行所在的段落
  marks?: LineMarks | undefined;
  className?: string | undefined;
}

// 共用的 Markdown 渲染（Contracts 21.1）：与 GitHub 一致——GFM、代码高亮、mermaid、frontmatter 表格、
// github-markdown-css。内容中的 HTML 经 rehype-sanitize 过滤，脚本与事件属性不会留下
export const Markdown = memo(function Markdown({
  content,
  filePath = '',
  fileHref,
  onOpenFile,
  imageSrc,
  marks,
  className,
}: MarkdownProps) {
  const article = useRef<HTMLElement>(null);

  const components: Components = {
    a(props) {
      const { href, children, ...rest } = domProps(props);
      if (href === undefined) return <a {...rest}>{children}</a>;
      if (href.startsWith('#')) {
        // 页内的锚点：标题与脚注的 id 带前缀
        const jump = (event: MouseEvent) => {
          event.preventDefault();
          const id = `${ID_PREFIX}${decodeURIComponent(href.slice(1))}`;
          article.current?.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView();
        };
        return (
          <a {...rest} href={href} onClick={jump}>
            {children}
          </a>
        );
      }
      if (hasScheme(href)) {
        return (
          <a {...rest} href={href} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        );
      }
      const path = resolvePath(filePath, href);
      if (fileHref === undefined) {
        return (
          <a {...rest} title={path} data-file={path}>
            {children}
          </a>
        );
      }
      return (
        <a
          {...rest}
          href={fileHref(path)}
          data-file={path}
          onClick={(event) => {
            if (onOpenFile === undefined) return;
            event.preventDefault();
            onOpenFile(path);
          }}
        >
          {children}
        </a>
      );
    },
    img(props) {
      const { src, alt, ...rest } = domProps(props);
      if (src === undefined || hasScheme(src)) return <img {...rest} src={src} alt={alt} />;
      const path = resolvePath(filePath, src);
      if (imageSrc === undefined) {
        return (
          <span className="md-image-path" data-file={path}>
            {alt === undefined || alt === '' ? path : alt}
          </span>
        );
      }
      return <img {...rest} src={imageSrc(path)} alt={alt} data-file={path} />;
    },
    pre({ node, children, ...rest }) {
      const code = mermaidCode(node);
      if (code !== null) return <MermaidDiagram code={code} />;
      return <pre {...rest}>{children}</pre>;
    },
  };

  return (
    <article ref={article} className={cn('markdown-body', className)} data-testid="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkFrontmatter, remarkFrontmatterTable, remarkGfm]}
        // 脚注的 id 不在这里加前缀，统一由 sanitize 加
        remarkRehypeOptions={{ clobberPrefix: '' }}
        rehypePlugins={[
          rehypeRaw,
          rehypeSlug,
          [rehypeSanitize, schema],
          [rehypeHighlight, { detect: false, plainText: ['mermaid'] }],
          [rehypeMarkLines, marks],
        ]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </article>
  );
});
