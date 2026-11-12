import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import {
  bindingKindLabel,
  bindingQuery,
  deriveVariantFromSession,
  putBinding,
} from '@/lib/analyses-api';
import { variantsQuery } from '@/pages/variants-api';

const selectClass = 'h-8 rounded-md border bg-background px-2 text-sm';

// Contracts 15.1: the session's bound variant, manual rebinding and unbinding, a new variant from the session's
// skills, and analyzing this session
export function SessionBinding({
  sessionId,
  title,
  fromRun,
}: {
  sessionId: string;
  title: string | null;
  // A session with a run; a run binding without a run is a Live interaction session (28.5)
  fromRun: boolean;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const binding = useQuery(bindingQuery(sessionId));
  const variants = useQuery(variantsQuery);
  const [choice, setChoice] = useState('');
  const [base, setBase] = useState('');
  const [name, setName] = useState(`Skills of session ${sessionId.slice(0, 8)}`);
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

  if (binding.isPending) return <p className="text-sm text-muted-foreground">Loading binding…</p>;
  if (binding.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        Failed to load binding: {binding.error.message}
      </p>
    );
  }
  const b = binding.data;
  const others = b.matching.filter((v) => v.id !== b.variant?.id);
  const baseId = base === '' ? (b.defaultBase?.id ?? '') : base;
  const error = change.error ?? derive.error;

  return (
    <section
      aria-label="Bound variant"
      className="flex flex-col gap-3 rounded-lg border px-4 py-3 text-sm"
      data-testid="session-binding"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="font-medium">Variant</h2>
        {b.variant === null ? (
          <span data-testid="binding-variant" className="text-muted-foreground">
            {b.binding === 'manual' ? 'Not bound (unbound manually)' : 'Not bound'}
          </span>
        ) : (
          <span data-testid="binding-variant">
            {b.variant.deleted ? (
              <span className="font-medium">{b.variant.name}</span>
            ) : (
              <Link className="font-medium underline" to={`/variants/${b.variant.id}`}>
                {b.variant.name}
              </Link>
            )}
            {b.binding !== null && (
              <span
                className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs"
                data-testid="binding-kind"
              >
                {bindingKindLabel(b.binding, fromRun)}
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
            Analyze this session
          </Link>
        ) : (
          <span className="ml-auto text-xs text-muted-foreground">Bind a variant to analyze</span>
        )}
      </div>
      {others.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="binding-others">
          Also matching:{' '}
          {others.map((v, i) => (
            <span key={v.id}>
              {i > 0 && ', '}
              <Link className="underline" to={`/variants/${v.id}`}>
                {v.name}
              </Link>
            </span>
          ))}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {b.skills.length === 0
          ? 'This session loaded no skills.'
          : `Loaded skills: ${b.skills.map((s) => (s.loads > 1 ? `${s.name} ×${String(s.loads)}` : s.name)).join(', ')}`}
      </p>
      {b.binding !== 'run' && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Change variant"
            className={selectClass}
            value={choice}
            onChange={(e) => {
              setChoice(e.target.value);
            }}
          >
            <option value="">Choose a variant</option>
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
            Bind
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
              Unbind
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
              Restore automatic binding
            </Button>
          )}
        </div>
      )}
      {b.skills.length > 0 && (
        <details className="rounded-md border px-3 py-2" data-testid="derive-from-session">
          <summary className="cursor-pointer font-medium">
            New variant from this session's skills
          </summary>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs">
              Base
              <select
                aria-label="Base variant"
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
              Name
              <input
                aria-label="New variant name"
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
              {derive.isPending ? 'Creating…' : 'New draft variant'}
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            The SKILL.md of each skill {title === null ? 'this session' : `"${title}"`} loaded is
            replaced with the text from the session; frontmatter and other files come from the base.
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
