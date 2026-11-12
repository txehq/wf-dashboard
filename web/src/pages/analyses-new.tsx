import {
  keepPreviousData,
  type UseQueryResult,
  useMutation,
  useQuery,
} from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { EngineChoice } from '@/components/engine-choice';
import { EngineLogo } from '@/components/live/live-identity';
import { ImportColumns } from '@/components/sessions/import-columns';
import { Button } from '@/components/ui/button';
import {
  type AnalysisEngine,
  type AnalysisScope,
  analysisOptionsQuery,
  createAnalysis,
  type ScopeSession,
  scopeQuery,
} from '@/lib/analyses-api';
import {
  configBlock,
  engineBlock,
  type Picked,
  pickedScope,
  pickLock,
  preselection,
  toggledPicks,
} from '@/lib/analysis-pick';
import { useSessionEngine } from '@/lib/session-view';
import type { SessionEngine } from '@/lib/sessions-api';

const SESSION_ORDER = ['claude', 'codex'] as const;
const engineNames = { claude: 'Claude Code', codex: 'Codex' } as const;

// Contracts 27: new analysis. Left: pick sessions straight from disk (the same three columns as the Sessions import area); right: a fixed settings panel.
// One analysis covers one config and one engine: once something is picked, other configs in the first column and the other engine are dimmed.
// Arriving from Sessions, Runs or a session detail preselects the sessions and their config (?picked=, ?batch=, ?sessions=)
export function AnalysisNewPage() {
  const [params] = useSearchParams();
  const [initial] = useState(() => preselection(params));
  const [storedEngine] = useSessionEngine();
  const [engine, setEngine] = useState<SessionEngine>(storedEngine);
  const [picked, setPicked] = useState<Picked[]>(() =>
    initial !== null && initial !== 'missing' && 'sessions' in initial
      ? initial.sessions.map((id) => ({ id, disk: null }))
      : [],
  );
  // ?batch=: the sessions of every run in the batch
  const batch = initial !== null && initial !== 'missing' && 'batch' in initial ? initial : null;
  const batchScope = useQuery({
    ...scopeQuery(batch ?? { batch: '' }),
    enabled: batch !== null,
  });
  const [seeded, setSeeded] = useState(false);
  if (!seeded && batchScope.data !== undefined) {
    setSeeded(true);
    setPicked(batchScope.data.sessions.map((s) => ({ id: s.id, disk: null })));
  }
  const scope = useQuery({
    ...scopeQuery(pickedScope(picked)),
    enabled: picked.length > 0,
    placeholderData: keepPreviousData,
  });
  const scoped = new Map((scope.data?.sessions ?? []).map((s) => [s.id, s]));
  const lock = pickLock(picked, scoped);
  // When arriving with a selection, switch to its engine
  if (lock !== null && lock.engine !== engine) setEngine(lock.engine);
  const pickedIds = new Set(picked.map((p) => p.id));

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="text-2xl font-semibold">New analysis</h1>
          <EngineChoice
            value={engine}
            onChange={setEngine}
            order={SESSION_ORDER}
            label="View"
            blocked={(e) => engineBlock(e, lock)}
          />
        </div>
        <p className="text-sm text-muted-foreground">
          Pick sessions from disk on the left, then set up and start the analysis on the right. One
          analysis takes sessions from one config and one engine: the local config or a single
          variant.
        </p>
      </header>
      {initial === 'missing' && (
        <p role="alert" className="text-sm text-destructive">
          This tab has no sessions passed to it (they are kept only in the tab that opened this
          page). Pick them again on the left.
        </p>
      )}
      {batchScope.isError && (
        <p role="alert" className="text-sm text-destructive">
          Couldn't load the batch's sessions: {batchScope.error.message}
        </p>
      )}
      <div className="grid grid-cols-[minmax(0,1fr)_300px] items-start gap-4 2xl:grid-cols-[minmax(0,1fr)_22rem]">
        <ImportColumns
          engine={engine}
          mode="pick"
          className="h-[calc(100svh-11rem)] min-h-96 grid-cols-[minmax(9rem,1fr)_minmax(10rem,1.2fr)_minmax(19rem,2.6fr)]"
          pick={{
            has: (s) => pickedIds.has(s.id),
            onChange: (list, want, place) => {
              setPicked((prev) =>
                toggledPicks(prev, list, want, {
                  engine,
                  config: place.config,
                  project: place.project,
                }),
              );
            },
            blocked: (c) => configBlock(c, lock),
            config: lock?.config ?? null,
          }}
        />
        <SettingsPanel
          picked={picked}
          scoped={scoped}
          scope={picked.length === 0 ? undefined : scope}
          onRemove={(id) => {
            setPicked((prev) => prev.filter((p) => p.id !== id));
          }}
          onClear={() => {
            setPicked([]);
          }}
        />
      </div>
    </div>
  );
}

// Title and project of a right-panel item: disk picks have them at once, preselected ones once the scope loads
function itemText(p: Picked, s: ScopeSession | undefined) {
  if (p.disk !== null) return { title: p.disk.title, project: p.disk.project, known: true };
  return { title: s?.title ?? null, project: s?.project ?? null, known: s !== undefined };
}

// Fixed settings panel on the right: picked sessions (remove and clear), their config and the scope check, method, engine and model, start
function SettingsPanel({
  picked,
  scoped,
  scope,
  onRemove,
  onClear,
}: {
  picked: Picked[];
  scoped: ReadonlyMap<string, ScopeSession>;
  scope: UseQueryResult<AnalysisScope> | undefined;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  const navigate = useNavigate();
  const options = useQuery(analysisOptionsQuery);
  const [engine, setEngine] = useState<AnalysisEngine>('claude');
  const [models, setModels] = useState<Partial<Record<AnalysisEngine, string>>>({});
  const model = models[engine] ?? options.data?.defaults[engine] ?? '';
  const [chosenVariant, setChosenVariant] = useState('');
  const analysisVariantId =
    chosenVariant === '' ? (options.data?.defaults.analysisVariantId ?? '') : chosenVariant;
  const create = useMutation({
    mutationFn: () =>
      createAnalysis({
        ...pickedScope(picked),
        engine,
        model: model.trim(),
        analysisVariantId,
      }),
    onSuccess: (created) => {
      void navigate(`/analyses/${created.id}`);
    },
  });
  const s = scope?.data;
  // Whether the scope matches the current picks (cannot start after the picks change until the new scope loads)
  const current =
    s !== undefined && !(scope?.isPlaceholderData ?? false) && s.sessions.length === picked.length;
  const toRead = s?.sessions.filter((x) => !x.inDashboard).length ?? 0;

  return (
    <aside
      aria-label="Analysis settings"
      className="sticky top-8 flex max-h-[calc(100svh-4rem)] flex-col rounded-lg border p-4"
      data-testid="analysis-settings"
    >
      <form
        className="flex min-h-0 flex-1 flex-col gap-4"
        aria-label="New analysis"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold" data-testid="picked-count">
            {picked.length} selected
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto"
            disabled={picked.length === 0}
            data-testid="picked-clear"
            onClick={onClear}
          >
            Clear
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={
              !current ||
              s.problem !== null ||
              model.trim() === '' ||
              analysisVariantId === '' ||
              create.isPending
            }
          >
            {create.isPending ? 'Starting…' : 'Start analysis'}
          </Button>
        </div>
        {create.isError && (
          <p role="alert" className="text-sm text-destructive">
            {create.error.message}
          </p>
        )}
        {scope?.isError === true && (
          <p role="alert" className="text-sm text-destructive">
            Couldn't load the scope: {scope.error.message}
          </p>
        )}
        {picked.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Click a config and a project on the left, then check its sessions.
          </p>
        ) : (
          s !== undefined && (
            <div className="flex flex-col gap-1.5 text-sm" data-testid="scope-check">
              {s.engine !== null && s.config !== null && (
                <p className="flex items-center gap-1.5" data-testid="scope-config">
                  <EngineLogo engine={s.engine} className="size-4 shrink-0" />
                  <span className="truncate">
                    {engineNames[s.engine]} · {s.config.label}
                  </span>
                </p>
              )}
              {s.problem !== null ? (
                <p role="alert" className="text-destructive" data-testid="scope-problem">
                  {s.problem}
                </p>
              ) : s.local ? (
                <p className="text-muted-foreground" data-testid="scope-local">
                  Local config sessions: each aspect analyzes only the sessions themselves, and the
                  result is a report with no suggested skill changes.
                </p>
              ) : (
                s.variant !== null && (
                  <p className="text-muted-foreground">
                    Analyzed against the skills of variant{' '}
                    <Link
                      className="text-foreground underline"
                      to={`/variants/${s.variant.id}`}
                      data-testid="scope-variant"
                    >
                      {s.variant.name}
                    </Link>
                    . Suggested changes can be saved as a new variant.
                  </p>
                )
              )}
              {s.problem === null && toRead > 0 && (
                <p className="text-muted-foreground" data-testid="scope-read-in">
                  {toRead} {toRead === 1 ? 'is' : 'are'} not in the dashboard yet. They are read in
                  at the start and not added to the Sessions management table.
                </p>
              )}
            </div>
          )
        )}
        <div className="flex shrink-0 flex-col gap-3 border-t pt-4">
          <label className="flex flex-col gap-1 text-sm font-medium">
            Method
            <select
              aria-label="Method"
              data-testid="analysis-variant"
              className="h-9 w-full rounded-md border bg-background px-2 text-sm font-normal"
              value={analysisVariantId}
              onChange={(e) => {
                setChosenVariant(e.target.value);
              }}
            >
              {analysisVariantId === '' && <option value="">No successfully built variant</option>}
              {(options.data?.analysisVariants ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                  {v.id === options.data?.defaults.analysisVariantId ? ' (default)' : ''}
                </option>
              ))}
            </select>
            <span className="text-xs font-normal text-muted-foreground">
              Variants of the workflow{' '}
              <Link className="underline" to="/workflows/session-analysis">
                session-analysis
              </Link>
              . Derive and build one to choose it here.
            </span>
          </label>
          <div className="flex flex-col gap-1 text-sm font-medium">
            Engine
            <EngineChoice
              value={engine}
              onChange={setEngine}
              order={['claude', 'codex']}
              label="Analysis engine"
            />
          </div>
          <label className="flex flex-col gap-1 text-sm font-medium">
            Model
            <input
              aria-label="Model"
              className="h-9 w-full rounded-md border bg-background px-3 font-mono text-sm font-normal"
              value={model}
              onChange={(e) => {
                setModels({ ...models, [engine]: e.target.value });
              }}
            />
            <span className="text-xs font-normal text-muted-foreground">
              {engine === 'claude'
                ? 'Defaults to the judge in Settings'
                : 'Defaults to ~/.codex/config.toml'}
            </span>
          </label>
        </div>
        {picked.length > 0 && (
          <ul
            className="-mx-1 flex min-h-16 flex-1 flex-col overflow-y-auto border-t pt-2 text-sm"
            data-testid="picked-list"
          >
            {picked.map((p) => {
              const text = itemText(p, scoped.get(p.id));
              const title = text.known ? (text.title ?? '(no user message)') : 'Loading…';
              return (
                <li
                  key={p.id}
                  className="flex items-start gap-1 rounded px-1 py-1.5 hover:bg-muted/60"
                  data-testid="picked-item"
                  data-session={p.id}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium" title={title}>
                      {title}
                    </p>
                    <p
                      className="truncate font-mono text-xs text-muted-foreground"
                      title={`${text.project ?? ''} · ${p.id}`}
                    >
                      {text.project ?? '—'} · {p.id.slice(0, 8)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0"
                    aria-label={`Remove ${title}`}
                    onClick={() => {
                      onRemove(p.id);
                    }}
                  >
                    <X />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </form>
    </aside>
  );
}
