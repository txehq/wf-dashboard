import { CircleAlert, CircleCheck, LoaderCircle } from 'lucide-react';
import { EnvironmentDialog } from '@/components/environment/environment-dialog';
import { useEnvironment } from '@/components/environment/environment-api';

// 左侧导航底部：全部通过 / 有 N 项未通过，点开是检查清单
export function EnvironmentStatus() {
  const { query } = useEnvironment();
  const failed = query.data?.checks.filter((c) => !c.ok).length ?? 0;
  const label = query.isError
    ? '环境检查失败'
    : query.data === undefined
      ? '环境检查中…'
      : failed === 0
        ? '环境：全部通过'
        : `环境：有 ${String(failed)} 项未通过`;
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
        ? 'text-emerald-700'
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
