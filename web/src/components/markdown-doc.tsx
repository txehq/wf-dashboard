import Markdown from 'react-markdown';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

// 产物文档的 markdown 渲染；frontmatter 不显示。bare 用于对话气泡内的 agent 文字：没有边框与内边距
export function MarkdownDoc({
  content,
  className,
  bare = false,
}: {
  content: string;
  className?: string;
  bare?: boolean;
}) {
  return (
    <article
      data-testid={bare ? undefined : 'artifact-markdown'}
      className={cn(
        'prose prose-sm max-w-none dark:prose-invert',
        !bare && 'overflow-auto rounded-lg border p-4',
        className,
      )}
    >
      <Markdown remarkPlugins={[remarkFrontmatter, remarkGfm]}>{content}</Markdown>
    </article>
  );
}
