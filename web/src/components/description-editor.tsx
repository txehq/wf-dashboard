import { useMutation } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

// workflow 与 variant 的基本描述（Contracts 18.3）：改了之后保存
export function DescriptionEditor({
  value,
  onSave,
  label,
}: {
  value: string | null;
  onSave: (description: string) => Promise<unknown>;
  label: string;
}) {
  const [text, setText] = useState(value ?? '');
  const save = useMutation({ mutationFn: () => onSave(text) });
  const changed = text.trim() !== (value ?? '').trim();
  return (
    <div className="flex flex-col gap-1.5 text-sm" data-testid="description-editor">
      <label className="flex flex-col gap-1.5">
        <span className="font-medium">{label}</span>
        <textarea
          className="min-h-16 max-w-3xl rounded-md border bg-background px-3 py-2"
          aria-label={label}
          value={text}
          placeholder="写一句这是做什么的"
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
      </label>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!changed || save.isPending}
          onClick={() => {
            save.mutate();
          }}
        >
          <Save />
          {save.isPending ? '保存中…' : '保存描述'}
        </Button>
        {save.isSuccess && !changed && (
          <span className="text-xs text-muted-foreground" data-testid="description-saved">
            已保存。
          </span>
        )}
        {save.isError && <span className="text-destructive">{save.error.message}</span>}
      </div>
    </div>
  );
}
