import { useMutation } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { cn } from '@/lib/utils';

// 直接改名（Contracts 14.3，交互项与 variant 共用）：双击名字或点铅笔图标，回车保存，Esc 取消；
// 保存失败时输入框保留，显示服务端的原文
export function InlineRename({
  value,
  label,
  testId,
  onSave,
  className,
  inputClassName,
  link,
}: {
  value: string;
  // 输入框的 aria-label，例如"交互的名字"
  label: string;
  // data-testid 的前缀：<testId>、<testId>-input 与 <testId>-rename
  testId: string;
  onSave: (next: string) => Promise<unknown>;
  className?: string;
  inputClassName?: string;
  // 名字本身是链接时（单击即打开）：显示这个链接，只用铅笔图标改名
  link?: (name: string) => ReactNode;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const saving = useMutation({
    mutationFn: onSave,
    onSuccess: () => {
      setDraft(null);
    },
  });
  const edit = () => {
    saving.reset();
    setDraft(value);
  };

  if (draft !== null) {
    return (
      <span className="flex min-w-0 flex-col gap-1">
        <input
          // 打开时直接可以输入
          autoFocus
          aria-label={label}
          data-testid={`${testId}-input`}
          className={cn(
            'h-7 w-full min-w-40 rounded border bg-background px-1.5 text-sm',
            inputClassName,
          )}
          value={draft}
          disabled={saving.isPending}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          // 外层可能是按钮或链接：输入框中的点击与按键不触发它们
          onClick={(event) => {
            event.stopPropagation();
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') saving.mutate(draft);
            else if (event.key === 'Escape') setDraft(null);
          }}
          onBlur={() => {
            if (!saving.isPending && !saving.isError) setDraft(null);
          }}
        />
        {saving.isError && (
          <span role="alert" className="text-xs whitespace-normal text-destructive">
            {saving.error.message}
          </span>
        )}
      </span>
    );
  }
  return (
    <span className="group flex min-w-0 items-center gap-1">
      {link === undefined ? (
        <span
          className={className}
          data-testid={testId}
          title={value}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            edit();
          }}
        >
          {value}
        </span>
      ) : (
        <span className={className} data-testid={testId} title={value}>
          {link(value)}
        </span>
      )}
      <span
        role="button"
        tabIndex={0}
        aria-label="改名"
        data-testid={`${testId}-rename`}
        className="shrink-0 rounded p-0.5 text-muted-foreground opacity-60 group-hover:opacity-100 hover:bg-muted hover:text-foreground"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          edit();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            edit();
          }
        }}
      >
        <Pencil className="size-3" />
      </span>
    </span>
  );
}
