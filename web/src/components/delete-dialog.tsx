import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DeletionPlan, SessionsChoice } from '@wf-dashboard/server/deletion/views';
import { Trash2, X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { type ReactNode, useState } from 'react';
import { useNavigate } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { requestJson } from '@/lib/http';
import { variantsQuery } from '@/pages/variants-api';

type Kind = 'variant' | 'workflow';

const base = (kind: Kind, id: string) =>
  `/api/${kind === 'variant' ? 'variants' : 'workflows'}/${encodeURIComponent(id)}`;

// 删除 variant 或 workflow（Contracts 24.6）：按钮放在已有的按钮组中；icon 为 true 时只显示图标（列表的行）
export function DeleteButton({
  kind,
  id,
  name,
  icon = false,
  after,
}: {
  kind: Kind;
  id: string;
  name: string;
  icon?: boolean;
  // 删除后去哪里；不给时留在当前页面
  after?: string;
}) {
  const [open, setOpen] = useState(false);
  const label = `删除${kind === 'variant' ? ' variant' : ' workflow'} ${name}`;
  return (
    <>
      {icon ? (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={label}
          title={label}
          data-testid={`delete-${kind}-${id}`}
          onClick={() => {
            setOpen(true);
          }}
        >
          <Trash2 />
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="text-destructive"
          data-testid={`delete-${kind}`}
          onClick={() => {
            setOpen(true);
          }}
        >
          <Trash2 />
          删除
        </Button>
      )}
      {open && (
        <DeleteDialog
          kind={kind}
          id={id}
          name={name}
          after={after}
          onClose={() => {
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  );
}

function Paths({ paths, testId }: { paths: string[]; testId: string }) {
  return (
    <ul
      className="max-h-40 overflow-auto rounded-md bg-muted px-2 py-1 font-mono text-xs"
      data-testid={testId}
    >
      {paths.map((p) => (
        <li key={p} className="truncate" title={p}>
          {p}
        </li>
      ))}
    </ul>
  );
}

function DeleteDialog({
  kind,
  id,
  name,
  after,
  onClose,
}: {
  kind: Kind;
  id: string;
  name: string;
  after: string | undefined;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const plan = useQuery({
    queryKey: ['delete-plan', kind, id],
    queryFn: async () =>
      (await requestJson('GET', `${base(kind, id)}/delete-plan`)) as DeletionPlan,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const variants = useQuery(variantsQuery);
  const [choice, setChoice] = useState<'delete' | 'rebind'>('rebind');
  const [rebindTo, setRebindTo] = useState('');
  const [typed, setTyped] = useState('');
  const remove = useMutation({
    mutationFn: async () => {
      const sessions: SessionsChoice =
        choice === 'delete' ? 'delete' : { rebindTo: rebindTo === '' ? null : rebindTo };
      return (await requestJson('DELETE', base(kind, id), { sessions })) as DeletionPlan;
    },
    onSuccess: async () => {
      if (after !== undefined) await navigate(after);
      onClose();
      await client.invalidateQueries();
    },
  });
  const p = plan.data;
  const removing = new Set((p?.variants ?? []).map((v) => v.id));
  const targets = (variants.data ?? []).filter((v) => !removing.has(v.id));
  const workflows = [...new Set(targets.map((v) => v.workflowId))];
  const blocked = p !== undefined && p.blockers.length > 0;
  const ready = p !== undefined && !blocked && typed === name && !remove.isPending;
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
          className="fixed top-1/2 left-1/2 z-[60] flex max-h-[90vh] w-[min(46rem,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-lg border bg-background p-4 shadow-lg"
          data-testid="delete-dialog"
          aria-describedby={undefined}
        >
          <div className="flex items-center gap-3">
            <Dialog.Title className="text-base font-semibold">
              删除 {kind} {name}
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
                <Alert variant="destructive" data-testid="delete-blockers">
                  <AlertTitle>现在不能删除</AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc pl-4">
                      {p.blockers.map((b) => (
                        <li key={`${b.kind}:${b.id}`}>{b.label}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
              {kind === 'workflow' && (
                <p className="text-sm">
                  一起删除它的 {p.variants.length} 个 variant
                  {p.drafts.length > 0 && `、${String(p.drafts.length)} 个草稿与草稿的 Live 项`}。
                </p>
              )}
              <Section title="删除的目录">
                {p.dirs.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    没有要删除的目录（与其他 variant 共用）。
                  </p>
                ) : (
                  <Paths paths={p.dirs} testId="delete-dirs" />
                )}
                {p.installs.length > 0 && (
                  <>
                    <p className="text-sm">装在本机，先按清单卸载：</p>
                    <Paths paths={p.installs.flatMap((i) => i.dirs)} testId="delete-installs" />
                  </>
                )}
              </Section>
              <Section title={`关联的 session（${String(p.sessions.count)} 个）`}>
                <div
                  className="flex flex-col gap-2 text-sm"
                  role="radiogroup"
                  aria-label="关联的 session"
                >
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="sessions"
                      data-testid="delete-sessions-rebind"
                      checked={choice === 'rebind'}
                      onChange={() => {
                        setChoice('rebind');
                      }}
                    />
                    改绑到
                    <select
                      className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2"
                      aria-label="改绑到"
                      data-testid="delete-rebind-target"
                      value={rebindTo}
                      disabled={choice !== 'rebind'}
                      onChange={(event) => {
                        setRebindTo(event.target.value);
                      }}
                    >
                      <option value="">本机配置（不绑定）</option>
                      {workflows.map((w) => (
                        <optgroup key={w} label={w}>
                          {targets
                            .filter((v) => v.workflowId === w)
                            .map((v) => (
                              <option key={v.id} value={v.id}>
                                {v.name}
                              </option>
                            ))}
                        </optgroup>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="sessions"
                      data-testid="delete-sessions-delete"
                      checked={choice === 'delete'}
                      onChange={() => {
                        setChoice('delete');
                      }}
                    />
                    一起删除：session 与它们在磁盘上的原始文件
                    {p.sessions.liveItems.length > 0 &&
                      `，以及 ${String(p.sessions.liveItems.length)} 个 Live 项`}
                  </label>
                  {choice === 'delete' && p.sessions.files.length > 0 && (
                    <Paths paths={p.sessions.files} testId="delete-session-files" />
                  )}
                  {p.sessions.agent > 0 && (
                    <p className="text-muted-foreground" data-testid="delete-agent-sessions">
                      另有本机配置的 Magi Agent 的 session {p.sessions.agent} 个（用的是本机的
                      ~/.claude）：不删除，Live 中的这些项也不删除；选一起删除时改为本机配置。
                    </p>
                  )}
                </div>
              </Section>
              <Section title="保留的记录（显示为「名字（已删除）」）">
                <p className="text-sm text-muted-foreground" data-testid="delete-retained">
                  run {p.retained.runs} 个（其中 session {p.retained.runSessions} 个随 run 保留）·
                  分析 {p.retained.analyses} 个 · Live 项 {p.retained.liveItems} 个 · 草稿{' '}
                  {p.retained.drafts} 个
                  {p.retained.children.length > 0 &&
                    ` · 派生出的 variant：${p.retained.children.map((c) => c.name).join('、')}`}
                </p>
              </Section>
            </div>
          )}
          {remove.isError && (
            <p role="alert" className="text-sm whitespace-pre-wrap text-destructive">
              {remove.error.message}
            </p>
          )}
          <div className="flex items-center gap-2 border-t pt-3">
            <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
              输入名字确认
              <Input
                className="h-8 min-w-0 flex-1"
                placeholder={name}
                data-testid="delete-confirm-name"
                value={typed}
                onChange={(event) => {
                  setTyped(event.target.value);
                }}
              />
            </label>
            <Button
              size="sm"
              variant="destructive"
              data-testid="delete-confirm"
              disabled={!ready}
              onClick={() => {
                remove.mutate();
              }}
            >
              <Trash2 />
              {remove.isPending ? '删除中…' : '删除'}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
