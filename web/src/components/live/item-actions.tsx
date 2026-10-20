import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Eye, MoreHorizontal, Trash2, X } from 'lucide-react';
import { DropdownMenu, Dialog } from 'radix-ui';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { deleteLive, hideLive, type LiveSummary, unhideLive } from '@/lib/live-api';

// 关闭、恢复显示与删除（Contracts 14.5）：有运行中进程的项不能关闭或删除，先结束进程

const stopFirst = '运行中：先结束进程';

// 左侧列表中一项的"×"：只从交互区隐藏，不需要确认
export function HideButton({ live, onHidden }: { live: LiveSummary; onHidden: () => void }) {
  const client = useQueryClient();
  const hiding = useMutation({
    mutationFn: () => hideLive(live.id),
    onSuccess: async () => {
      onHidden();
      await client.invalidateQueries({ queryKey: ['live'] });
    },
  });
  const running = live.status === 'running';
  return (
    <button
      type="button"
      aria-label="关闭这一项"
      title={running ? stopFirst : '关闭（只从交互区隐藏，可以恢复显示）'}
      data-testid="live-hide"
      disabled={running || hiding.isPending}
      className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      onClick={(event) => {
        event.stopPropagation();
        hiding.mutate();
      }}
    >
      <X className="size-3.5" />
    </button>
  );
}

// 已关闭的项的"恢复显示"
export function UnhideButton({ live }: { live: LiveSummary }) {
  const client = useQueryClient();
  const showing = useMutation({
    mutationFn: () => unhideLive(live.id),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['live'] });
    },
  });
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 px-2 text-xs"
      data-testid="live-unhide"
      disabled={showing.isPending}
      onClick={(event) => {
        event.stopPropagation();
        showing.mutate();
      }}
    >
      <Eye />
      恢复显示
    </Button>
  );
}

// 删除的确认框：列出将要删除与不删除的内容，输入这一项的名字后才能删除
function DeleteDialog({
  live,
  open,
  onOpenChange,
  onDeleted,
}: {
  live: LiveSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const client = useQueryClient();
  const [typed, setTyped] = useState('');
  const deleting = useMutation({
    mutationFn: () => deleteLive(live.id, typed),
    onSuccess: async () => {
      onOpenChange(false);
      onDeleted();
      await client.invalidateQueries({ queryKey: ['live'] });
      await client.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) setTyped('');
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 z-50 flex w-[34rem] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-lg border bg-background p-5 shadow-lg"
          data-testid="delete-dialog"
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          <Dialog.Title className="text-base font-semibold">删除这一项</Dialog.Title>
          <Dialog.Description asChild>
            <div className="flex flex-col gap-2 text-sm">
              <p>将要删除：</p>
              <ul className="list-disc pl-5">
                <li>交互项「{live.title}」，它的进程与事件记录</li>
                <li>
                  <code className="text-xs break-all">data/live/{live.id}/</code>
                  ：终端输出、hooks.json、isolated 环境的 workspace
                </li>
                {live.purpose === 'agent' && <li>这个会话发起的部署记录</li>}
              </ul>
              <p>不会删除：</p>
              {live.purpose === 'agent' ? (
                // Magi Agent 的会话（Contracts 23.1）：session 文件在用户自己的配置目录或 variant 的配置目录中
                <ul
                  className="list-disc pl-5 text-muted-foreground"
                  data-testid="delete-agent-files"
                >
                  <li>
                    磁盘上的 session 文件（
                    {live.engine === 'codex'
                      ? '~/.codex 下的'
                      : live.agentConfig === 'local'
                        ? '~/.claude 下的'
                        : `variant ${live.agentConfigName ?? ''} 的配置目录下的`}
                    ）与 Sessions 中的记录
                  </li>
                  <li>worktree 与 magi-agent 分支</li>
                </ul>
              ) : (
                <ul className="list-disc pl-5 text-muted-foreground">
                  <li>session 本身（Claude Code 的 jsonl 与副本、Sessions 中的记录）</li>
                  <li>GitHub 仓库与 Linear 工单（由你自己处理）</li>
                </ul>
              )}
            </div>
          </Dialog.Description>
          <label className="flex flex-col gap-1.5 text-sm">
            <span>
              输入这一项的名字确认：<span className="font-medium">{live.title}</span>
            </span>
            <Input
              aria-label="输入名字确认删除"
              data-testid="delete-confirm-input"
              value={typed}
              onChange={(event) => {
                setTyped(event.target.value);
              }}
            />
          </label>
          {deleting.isError && (
            <p role="alert" className="text-sm text-destructive">
              {deleting.error.message}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="outline">取消</Button>
            </Dialog.Close>
            <Button
              variant="destructive"
              data-testid="delete-confirm"
              disabled={typed !== live.title || deleting.isPending}
              onClick={() => {
                deleting.mutate();
              }}
            >
              <Trash2 />
              {deleting.isPending ? '正在删除…' : '删除'}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// 每一项的菜单："删除"
export function ItemMenu({ live, onDeleted }: { live: LiveSummary; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const running = live.status === 'running';
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label="这一项的菜单"
            data-testid="live-menu"
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <MoreHorizontal className="size-3.5" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            className="z-50 min-w-36 rounded-md border bg-background p-1 shadow-md"
          >
            <DropdownMenu.Item
              data-testid="live-delete"
              disabled={running}
              title={running ? stopFirst : undefined}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-destructive outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40 data-[highlighted]:bg-muted"
              onSelect={() => {
                setConfirming(true);
              }}
            >
              <Trash2 className="size-3.5" />
              删除…
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <DeleteDialog
        live={live}
        open={confirming}
        onOpenChange={setConfirming}
        onDeleted={onDeleted}
      />
    </>
  );
}
