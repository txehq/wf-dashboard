import { RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Shows the server's error text when a request fails; no automatic retry, the user clicks Retry
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
        {retrying ? 'Retrying…' : 'Retry'}
      </Button>
    </div>
  );
}
