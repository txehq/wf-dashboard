import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { SessionBrowser } from '@/components/sessions/session-browser';
import { SourcePicker } from '@/components/sessions/source-picker';
import { Button } from '@/components/ui/button';
import { importLive, type LiveSummary } from '@/lib/live-api';
import type { SessionSummary } from '@/lib/sessions-api';

// 不在交互区的 session 可选；所属的项已关闭的也可选，导入即恢复显示（Contracts 14.5）
const importable = (s: SessionSummary) => s.liveId === null || s.liveHidden;

// "导入本机 session"（Contracts 14.5）：与 Sessions 页面相同，上方勾选来源目录（同一份 /api/sources 设置），
// 下方是勾选目录中的 session 列表（同一个组件与 /api/sessions），多选后导入
function ImportForm({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (items: LiveSummary[]) => void;
}) {
  const client = useQueryClient();
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const importing = useMutation({
    mutationFn: () => importLive([...chosen]),
    onSuccess: async (items) => {
      await client.invalidateQueries({ queryKey: ['live'] });
      await client.invalidateQueries({ queryKey: ['sessions'] });
      onImported(items);
    },
  });
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto" data-testid="import-list">
        <SourcePicker />
        <SessionBrowser
          mode="pick"
          selected={chosen}
          isSelectable={importable}
          onToggle={(id) => {
            const next = new Set(chosen);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            setChosen(next);
          }}
        />
      </div>
      {importing.isError && (
        <p role="alert" className="text-sm text-destructive">
          {importing.error.message}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          取消
        </Button>
        <Button
          data-testid="import-confirm"
          disabled={chosen.size === 0 || importing.isPending}
          onClick={() => {
            importing.mutate();
          }}
        >
          <Download />
          {importing.isPending ? '正在导入…' : `导入 ${String(chosen.size)} 个`}
        </Button>
      </div>
    </div>
  );
}

export function ImportSessionsButton({
  onImported,
}: {
  onImported: (items: LiveSummary[]) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        data-testid="import-open"
        onClick={() => {
          setOpen(true);
        }}
      >
        <Download />
        导入本机 session
      </Button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="导入本机 session"
            className="flex max-h-[90vh] w-[72rem] max-w-[95vw] flex-col gap-4 rounded-lg border bg-background p-5 shadow-lg"
            data-testid="import-dialog"
          >
            <h2 className="text-base font-semibold">导入本机 session</h2>
            <ImportForm
              onClose={() => {
                setOpen(false);
              }}
              onImported={(items) => {
                setOpen(false);
                onImported(items);
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}
