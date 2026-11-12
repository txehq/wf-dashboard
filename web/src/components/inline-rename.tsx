import { useMutation } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { cn } from '@/lib/utils';

// Inline rename (Contracts 14.3, shared by interactions and variants): double-click the name or click the pencil;
// Enter saves, Esc cancels. When saving fails the input stays and shows the server's error
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
  // The input's aria-label, e.g. "Interaction name"
  label: string;
  // data-testid prefix: <testId>, <testId>-input and <testId>-rename
  testId: string;
  onSave: (next: string) => Promise<unknown>;
  className?: string;
  inputClassName?: string;
  // When the name itself is a link (a click opens it): show the link and rename only through the pencil
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
          // Ready for typing when opened
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
          // The parent may be a button or link: clicks and keys in the input must not trigger it
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
        aria-label="Rename"
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
