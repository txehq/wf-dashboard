import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { EngineChoice } from '@/components/engine-choice';
import { ImportColumns } from '@/components/sessions/import-columns';
import { Button } from '@/components/ui/button';
import { importLive, type LiveSummary } from '@/lib/live-api';
import { useSessionEngine } from '@/lib/session-view';
import { importSessions, type PickedSession } from '@/lib/sessions-api';

// "导入本机 session"（Contracts 14.5、25.1）：与 Sessions 页面相同的视图切换与三列。已在交互区的不能勾选；所属的项已关闭的
// 可选，导入即恢复显示。"导入 N 个"先导入进管理表格，再导入交互区；切换视图时清除勾选
function ImportForm({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (items: LiveSummary[]) => void;
}) {
  const client = useQueryClient();
  const [engine, setEngine] = useSessionEngine();
  const [chosen, setChosen] = useState<ReadonlyMap<string, PickedSession>>(new Map());
  const importing = useMutation({
    mutationFn: async () => {
      const { sessions } = await importSessions(engine, [...chosen.keys()]);
      return importLive(sessions.map((s) => s.id));
    },
    onSuccess: async (items) => {
      await client.invalidateQueries({ queryKey: ['live'] });
      await client.invalidateQueries({ queryKey: ['sessions'] });
      await client.invalidateQueries({ queryKey: ['session-import'] });
      onImported(items);
    },
  });
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <EngineChoice
        value={engine}
        onChange={(next) => {
          setEngine(next);
          setChosen(new Map());
        }}
        order={['claude', 'codex']}
        label="视图"
      />
      <div data-testid="import-list">
        <ImportColumns engine={engine} mode="live" changes={chosen} onChanges={setChosen} />
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
