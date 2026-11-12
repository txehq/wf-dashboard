import Markdown from 'react-markdown';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

// Markdown rendering for output documents, without frontmatter. bare is for agent text in chat bubbles: no border or padding
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
