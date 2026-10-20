import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Eraser, Trash2, X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { actionPlanQuery, runSessionAction, type SessionAction } from '@/lib/sessions-api';
import type { SelectedSession } from '@/lib/session-selection';

// 表格多选与详情页头部的清除、删除、归档与恢复（Contracts 25.1、25.3）。清除只从管理表格中去掉（磁盘上的文件不动，
// 之后从上面重新导入），直接执行；Claude Code 另有删除，Codex 另有归档（已归档的为恢复）与删除。
// 删除先看确认对话框（将要删除的 session 与每个文件的路径），归档与恢复直接执行；拒绝与失败以原文显示
export type ActionTarget = SelectedSession;

async function refresh(client: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    client.invalidateQueries({ queryKey: ['sessions'] }),
    client.invalidateQueries({ queryKey: ['session-import'] }),
    client.invalidateQueries({ queryKey: ['session'] }),
    client.invalidateQueries({ queryKey: ['live'] }),
  ]);
}

export function SessionActionButtons({
  targets,
  onDone,
}: {
  targets: ActionTarget[];
  // 执行成功后（清除选择，或从详情页回到列表）
  onDone: (action: SessionAction) => void;
}) {
  const client = useQueryClient();
  const [deleting, setDeleting] = useState(false);
  const ids = targets.map((t) => t.id);
  const codex = targets.length > 0 && targets.every((t) => t.engine === 'codex');
  const archived = targets.filter((t) => t.archived).length;
  const move = useMutation({
    mutationFn: (action: 'clear' | 'archive' | 'unarchive') => runSessionAction(action, ids),
    onSuccess: async (_plan, action) => {
      await refresh(client);
      onDone(action);
    },
    onError: async () => {
      // 部分完成时（之前的已归档）列表随之更新
      await refresh(client);
    },
  });
  const pending = move.isPending ? move.variables : null;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        data-testid="session-clear"
        title="从管理表格中去掉，磁盘上的文件不动；之后可以从上面重新导入"
        disabled={targets.length === 0 || move.isPending}
        onClick={() => {
          move.mutate('clear');
        }}
      >
        <Eraser />
        {pending === 'clear' ? '正在清除…' : '清除'}
      </Button>
      {codex && archived === 0 && (
        <Button
          size="sm"
          variant="outline"
          data-testid="session-archive"
          disabled={move.isPending}
          onClick={() => {
            move.mutate('archive');
          }}
        >
          <Archive />
          {pending === 'archive' ? '正在归档…' : '归档'}
        </Button>
      )}
      {codex && archived === targets.length && (
        <Button
          size="sm"
          variant="outline"
          data-testid="session-unarchive"
          disabled={move.isPending}
          onClick={() => {
            move.mutate('unarchive');
          }}
        >
          <ArchiveRestore />
          {pending === 'unarchive' ? '正在恢复…' : '恢复'}
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        className="text-destructive"
        data-testid="session-delete"
        disabled={targets.length === 0}
        onClick={() => {
          setDeleting(true);
        }}
      >
        <Trash2 />
        删除
      </Button>
      {move.isError && (
        <p
          role="alert"
          className="basis-full text-sm whitespace-pre-wrap text-destructive"
          data-testid="session-action-error"
        >
          {move.error.message}
        </p>
      )}
      {deleting && (
        <DeleteSessionsDialog
          ids={ids}
          onClose={() => {
            setDeleting(false);
          }}
          onDeleted={() => {
            setDeleting(false);
            onDone('delete');
          }}
        />
      )}
    </>
  );
}

function DeleteSessionsDialog({
  ids,
  onClose,
  onDeleted,
}: {
  ids: string[];
  onClose: () => void;
  onDeleted: () => void;
}) {
  const client = useQueryClient();
  const plan = useQuery({
    ...actionPlanQuery('delete', ids),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const remove = useMutation({
    mutationFn: () => runSessionAction('delete', ids),
    onSuccess: async () => {
      await refresh(client);
      onDeleted();
    },
    onError: async () => {
      await refresh(client);
    },
  });
  const p = plan.data;
  const blocked = p !== undefined && p.blockers.length > 0;
  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/30" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 z-[60] flex max-h-[90vh] w-[min(52rem,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-lg border bg-background p-4 shadow-lg"
          data-testid="session-delete-dialog"
          aria-describedby={undefined}
        >
          <div className="flex items-center gap-3">
            <Dialog.Title className="text-base font-semibold">
              永久删除 {ids.length} 个 session
            </Dialog.Title>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>
              <X />
              取消
            </Button>
          </div>
          {plan.isPending && <p className="text-sm text-muted-foreground">读取中…</p>}
          {plan.isError && (
            <p role="alert" className="text-sm whitespace-pre-wrap text-destructive">
              {plan.error.message}
            </p>
          )}
          {p !== undefined && (
            <div className="flex min-h-0 flex-col gap-4 overflow-auto pr-1">
              {blocked && (
                <Alert variant="destructive" data-testid="session-delete-blockers">
                  <AlertTitle>现在不能删除</AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc pl-4">
                      {p.blockers.map((b) => (
                        <li key={`${b.sessionId}:${b.label}`}>{b.label}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
              <p className="text-sm">
                dashboard 中的记录（请求、阶段、绑定）与磁盘上的下列文件一起删除，不能恢复。
              </p>
              <ul className="flex flex-col gap-3" data-testid="session-delete-list">
                {p.sessions.map((s) => (
                  <li key={s.id} className="flex flex-col gap-1" data-session={s.id}>
                    <span className="text-sm font-medium">
                      {s.title ?? '（没有用户消息）'}
                      <span className="ml-2 font-mono text-xs text-muted-foreground">
                        {s.id.slice(0, 8)}
                      </span>
                    </span>
                    {s.engine === 'codex' && (
                      <span className="text-xs text-muted-foreground">
                        由 codex delete 永久删除
                      </span>
                    )}
                    <ul className="max-h-40 overflow-auto rounded-md bg-muted px-2 py-1 font-mono text-xs">
                      {s.files.map((f) => (
                        <li key={f} className="truncate" title={f}>
                          {f}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
              {p.liveItems.length > 0 && (
                <p className="text-sm" data-testid="session-delete-live">
                  属于它们的 Live 项连同目录一起删除：
                  {p.liveItems.map((i) => i.title).join('、')}
                </p>
              )}
            </div>
          )}
          {remove.isError && (
            <p role="alert" className="text-sm whitespace-pre-wrap text-destructive">
              {remove.error.message}
            </p>
          )}
          <div className="flex justify-end gap-2 border-t pt-3">
            <Button size="sm" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button
              size="sm"
              variant="destructive"
              data-testid="session-delete-confirm"
              disabled={p === undefined || blocked || remove.isPending}
              onClick={() => {
                remove.mutate();
              }}
            >
              <Trash2 />
              {remove.isPending ? '删除中…' : '永久删除'}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
