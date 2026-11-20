import { CircleAlert } from 'lucide-react';
import { EnvironmentDialog } from '@/components/environment/environment-dialog';
import { useEnvironment } from '@/components/environment/environment-api';

// Next to the Start batch button: lists failed checks (unverified ones are checked when the batch starts); opens the
// checklist
export function EnvironmentWarning() {
  const { query } = useEnvironment();
  const failed = query.data?.checks.filter((c) => c.state === 'failed') ?? [];
  if (failed.length === 0) return null;
  return (
    <div
      className="flex items-start gap-2 rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive"
      data-testid="environment-warning"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="flex flex-col gap-1">
        <span>
          {failed.length} environment {failed.length === 1 ? 'check' : 'checks'} failed; affected
          runs may fail: {failed.map((c) => c.label).join('; ')}
        </span>
        <EnvironmentDialog
          trigger={
            <button type="button" className="w-fit underline">
              See causes and fixes
            </button>
          }
        />
      </div>
    </div>
  );
}
