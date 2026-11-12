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
import { type FrontmatterLayout, remarkFrontmatterTable } from './frontmatter';
import { type LineMarks, rehypeMarkLines } from './mark-lines';
import { MermaidDiagram } from './mermaid';
import './theme';

// GitHub's allowlist (rehype-sanitize's default schema), plus the class of the frontmatter table and list
const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    table: [...(defaultSchema.attributes?.table ?? []), ['className', 'frontmatter']],
    dl: [...(defaultSchema.attributes?.dl ?? []), ['className', 'frontmatter']],
  },
};

// Prefix sanitize adds to ids so ids in the content do not clash with the page's
const ID_PREFIX = 'user-content-';

const hasScheme = (url: string) => /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//');

// Resolves a relative path against the containing file, giving a path relative to the root
function resolvePath(filePath: string, target: string): string {
  const base = `file:///${filePath.split('/').map(encodeURIComponent).join('/')}`;
  return decodeURIComponent(new URL(target, base).pathname.slice(1));
}

// The node (hast node) react-markdown passes to components is not a DOM attribute
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
  // Path of the file this content comes from: relative links and images resolve against it
  filePath?: string | undefined;
  // Links to other files: the address, and the action on click (without an action the link follows the address)
  fileHref?: ((path: string) => string) | undefined;
  onOpenFile?: ((path: string) => void) | undefined;
  // Address of an image with a relative path
  imageSrc?: ((path: string) => string) | undefined;
  // Paragraphs to mark, by source line
  marks?: LineMarks | undefined;
  // Frontmatter display: a table (default, as on GitHub) or the vertical "key: value" list for narrow places
  frontmatter?: FrontmatterLayout | undefined;
  className?: string | undefined;
}

// Shared Markdown rendering (Contracts 21.1), matching GitHub: GFM, code highlighting, mermaid, frontmatter table,
// github-markdown-css. HTML in the content passes through rehype-sanitize, so scripts and event attributes are removed
export const Markdown = memo(function Markdown({
  content,
  filePath = '',
  fileHref,
  onOpenFile,
  imageSrc,
  marks,
  frontmatter = 'table',
  className,
}: MarkdownProps) {
  const article = useRef<HTMLElement>(null);

  const components: Components = {
    a(props) {
      const { href, children, ...rest } = domProps(props);
      if (href === undefined) return <a {...rest}>{children}</a>;
      if (href.startsWith('#')) {
        // In-page anchors: heading and footnote ids carry the prefix
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
        remarkPlugins={[
          remarkFrontmatter,
          [remarkFrontmatterTable, { layout: frontmatter }],
          remarkGfm,
        ]}
        // Footnote ids get no prefix here; sanitize adds it to all ids
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
