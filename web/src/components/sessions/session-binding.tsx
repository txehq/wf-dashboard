import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import {
  bindingLabel,
  bindingQuery,
  deriveVariantFromSession,
  putBinding,
} from '@/lib/analyses-api';
import { variantsQuery } from '@/pages/variants-api';

const selectClass = 'h-8 rounded-md border bg-background px-2 text-sm';

// Contracts 15.1：session 绑定的 variant、手动改选与解除、按 session 的 skill 新建 variant、分析这个 session
export function SessionBinding({ sessionId, title }: { sessionId: string; title: string | null }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const binding = useQuery(bindingQuery(sessionId));
  const variants = useQuery(variantsQuery);
  const [choice, setChoice] = useState('');
  const [base, setBase] = useState('');
  const [name, setName] = useState(`session ${sessionId.slice(0, 8)} 的 skill`);
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ['session', sessionId] });
    await client.invalidateQueries({ queryKey: ['sessions'] });
  };
  const change = useMutation({
    mutationFn: (body: { variantId: string | null } | { auto: true }) =>
      putBinding(sessionId, body),
    onSuccess: refresh,
  });
  const derive = useMutation({
    mutationFn: (body: { baseVariantId: string; name: string }) =>
      deriveVariantFromSession(sessionId, body),
    onSuccess: async (created) => {
      await refresh();
      await client.invalidateQueries({ queryKey: ['variants'] });
      void navigate(`/variants/${created.id}`);
    },
  });

  if (binding.isPending) return <p className="text-sm text-muted-foreground">正在读取绑定…</p>;
  if (binding.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        读取绑定失败：{binding.error.message}
      </p>
    );
  }
  const b = binding.data;
  const others = b.matching.filter((v) => v.id !== b.variant?.id);
  const baseId = base === '' ? (b.defaultBase?.id ?? '') : base;
  const error = change.error ?? derive.error;

  return (
    <section
      aria-label="绑定的 variant"
      className="flex flex-col gap-3 rounded-lg border px-4 py-3 text-sm"
      data-testid="session-binding"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="font-medium">variant</h2>
        {b.variant === null ? (
          <span data-testid="binding-variant" className="text-muted-foreground">
            {b.binding === 'manual' ? '未绑定（已手动解除）' : '未绑定'}
          </span>
        ) : (
          <span data-testid="binding-variant">
            <Link className="font-medium underline" to={`/variants/${b.variant.id}`}>
              {b.variant.name}
            </Link>
            {b.binding !== null && (
              <span
                className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs"
                data-testid="binding-kind"
              >
                {bindingLabel[b.binding]}
              </span>
            )}
          </span>
        )}
        {b.variant !== null ? (
          <Link
            to={`/analyses/new?sessions=${sessionId}`}
            className="ml-auto text-sm font-medium underline"
            data-testid="analyze-session"
          >
            分析这个 session
          </Link>
        ) : (
          <span className="ml-auto text-xs text-muted-foreground">绑定 variant 后可以分析</span>
        )}
      </div>
      {others.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="binding-others">
          同样一致：
          {others.map((v, i) => (
            <span key={v.id}>
              {i > 0 && '、'}
              <Link className="underline" to={`/variants/${v.id}`}>
                {v.name}
              </Link>
            </span>
          ))}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {b.skills.length === 0
          ? '这个 session 没有加载过 skill。'
          : `加载过的 skill：${b.skills.map((s) => (s.loads > 1 ? `${s.name} ×${String(s.loads)}` : s.name)).join('、')}`}
      </p>
      {b.binding !== 'run' && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="改选 variant"
            className={selectClass}
            value={choice}
            onChange={(e) => {
              setChoice(e.target.value);
            }}
          >
            <option value="">选择 variant</option>
            {variants.data?.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            disabled={choice === '' || change.isPending}
            onClick={() => {
              change.mutate({ variantId: choice });
            }}
          >
            绑定
          </Button>
          {b.variant !== null && (
            <Button
              size="sm"
              variant="outline"
              disabled={change.isPending}
              onClick={() => {
                change.mutate({ variantId: null });
              }}
            >
              解除绑定
            </Button>
          )}
          {b.binding === 'manual' && (
            <Button
              size="sm"
              variant="ghost"
              disabled={change.isPending}
              onClick={() => {
                change.mutate({ auto: true });
              }}
            >
              恢复自动判定
            </Button>
          )}
        </div>
      )}
      {b.skills.length > 0 && (
        <details className="rounded-md border px-3 py-2" data-testid="derive-from-session">
          <summary className="cursor-pointer font-medium">
            按这个 session 的 skill 新建 variant
          </summary>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs">
              底子
              <select
                aria-label="底子 variant"
                className={selectClass}
                value={baseId}
                onChange={(e) => {
                  setBase(e.target.value);
                }}
              >
                {variants.data?.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              名称
              <input
                aria-label="新 variant 的名称"
                className="h-8 w-72 rounded-md border bg-background px-2 text-sm"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                }}
              />
            </label>
            <Button
              size="sm"
              disabled={baseId === '' || name.trim() === '' || derive.isPending}
              onClick={() => {
                derive.mutate({ baseVariantId: baseId, name: name.trim() });
              }}
            >
              {derive.isPending ? '正在新建…' : '新建草稿 variant'}
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {title === null ? '' : `「${title}」`}加载过的 skill 的 SKILL.md 换成 session
            中的正文，frontmatter 与其他文件来自底子。
          </p>
        </details>
      )}
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      )}
    </section>
  );
}
