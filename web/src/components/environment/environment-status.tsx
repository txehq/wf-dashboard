import { CircleAlert, CircleCheck, LoaderCircle } from 'lucide-react';
import { EnvironmentDialog } from '@/components/environment/environment-dialog';
import { useEnvironment } from '@/components/environment/environment-api';

// Bottom of the side nav: all passed / N failed; opens the checklist
export function EnvironmentStatus() {
  const { query } = useEnvironment();
  const failed = query.data?.checks.filter((c) => !c.ok).length ?? 0;
  const label = query.isError
    ? 'Environment check failed'
    : query.data === undefined
      ? 'Checking environment…'
      : failed === 0
        ? 'Environment: all passed'
        : `Environment: ${String(failed)} failed`;
  const Icon =
    query.data === undefined && !query.isError
      ? LoaderCircle
      : failed === 0 && !query.isError
        ? CircleCheck
        : CircleAlert;
  const tone =
    query.data === undefined && !query.isError
      ? 'text-muted-foreground'
      : failed === 0 && !query.isError
        ? 'text-status-good'
        : 'text-destructive';

  return (
    <EnvironmentDialog
      trigger={
        <button
          type="button"
          className={`mx-2 flex items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs hover:bg-background ${tone}`}
          data-testid="environment-status"
        >
          <Icon
            className={`size-4 shrink-0 ${Icon === LoaderCircle ? 'animate-spin' : ''}`}
            aria-hidden
          />
          {label}
        </button>
      }
    />
  );
}
