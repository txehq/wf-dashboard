import { CircleAlert } from 'lucide-react';
import { EnvironmentDialog } from '@/components/environment/environment-dialog';
import { useEnvironment } from '@/components/environment/environment-api';

// 发起 batch 的按钮旁：有未通过的项时列出它们，点开是检查清单
export function EnvironmentWarning() {
  const { query } = useEnvironment();
  const failed = query.data?.checks.filter((c) => !c.ok) ?? [];
  if (failed.length === 0) return null;
  return (
    <div
      className="flex items-start gap-2 rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive"
      data-testid="environment-warning"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="flex flex-col gap-1">
        <span>
          运行环境有 {failed.length} 项未通过，相关的 run 可能失败：
          {failed.map((c) => c.label).join('；')}
        </span>
        <EnvironmentDialog
          trigger={
            <button type="button" className="w-fit underline">
              查看原因与修复方法
            </button>
          }
        />
      </div>
    </div>
  );
}
