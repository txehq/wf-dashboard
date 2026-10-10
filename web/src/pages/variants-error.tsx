import { RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

// 请求失败时显示服务端返回的错误原文；不自动重复请求，由用户点「重试」
export function QueryError({
  error,
  retrying,
  onRetry,
  className,
}: {
  error: Error;
  retrying: boolean;
  onRetry: () => void;
  className?: string;
}) {
  return (
    <div role="alert" className={`flex flex-col items-start gap-2 text-sm ${className ?? ''}`}>
      <p className="break-all whitespace-pre-wrap text-destructive" data-testid="query-error">
        {error.message}
      </p>
      <Button size="xs" variant="outline" disabled={retrying} onClick={onRetry}>
        <RotateCw className={retrying ? 'animate-spin' : ''} />
        {retrying ? '重试中…' : '重试'}
      </Button>
    </div>
  );
}
