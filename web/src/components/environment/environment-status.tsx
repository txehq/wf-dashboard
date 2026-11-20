import { CircleAlert, CircleCheck, LoaderCircle } from 'lucide-react';
import { EnvironmentDialog } from '@/components/environment/environment-dialog';
import { paidName, useEnvironment, verifiedText } from '@/components/environment/environment-api';

// Bottom of the side nav: all passed / N failed, then when each paid check was last verified; opens the checklist.
// Unverified does not count as failed
export function EnvironmentStatus() {
  const { query } = useEnvironment();
  const checks = query.data?.checks ?? [];
  const failed = checks.filter((c) => c.state === 'failed').length;
  const paid = checks.flatMap((c) => {
    const name = paidName(c);
    return name === undefined ? [] : [{ id: c.id, name, text: verifiedText(c) }];
  });
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
          className="mx-2 flex flex-col gap-0.5 rounded-md px-3 py-1.5 text-left text-xs hover:bg-background"
          data-testid="environment-status"
        >
          <span className={`flex items-center gap-2 ${tone}`}>
            <Icon
              className={`size-4 shrink-0 ${Icon === LoaderCircle ? 'animate-spin' : ''}`}
              aria-hidden
            />
            {label}
          </span>
          {paid.map((p) => (
            <span
              key={p.id}
              className="truncate pl-6 text-[11px] text-muted-foreground"
              data-testid={`environment-paid-${p.id}`}
            >
              {p.name}: {p.text}
            </span>
          ))}
        </button>
      }
    />
  );
}
