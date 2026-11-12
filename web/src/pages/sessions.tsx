import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { EngineChoice } from '@/components/engine-choice';
import { ImportColumns } from '@/components/sessions/import-columns';
import { SessionActionButtons } from '@/components/sessions/session-actions';
import { SessionManager } from '@/components/sessions/session-manager';
import { Button } from '@/components/ui/button';
import { rememberPicked } from '@/lib/analyses-api';
import { applyLabel, type ImportChanges, splitChanges, withoutApplied } from '@/lib/import-changes';
import { useSessionEngine } from '@/lib/session-view';
import {
  importSessions,
  runSessionAction,
  type SessionEngine,
  useSessionEvents,
} from '@/lib/sessions-api';

const SESSION_ORDER = ['claude', 'codex'] as const;

// Top: import and clear (Contracts 25.1). Sessions checked in the three columns are in the manage table below;
// changes are staged, and Apply imports first, then clears, with no confirmation (clear leaves the disk alone).
// A failed step is shown as returned; completed parts stay and only the unfinished changes remain staged
function ImportPanel({ engine }: { engine: SessionEngine }) {
  const client = useQueryClient();
  const [changes, setChanges] = useState<ImportChanges>(new Map());
  const [changesFor, setChangesFor] = useState(engine);
  if (changesFor !== engine) {
    setChangesFor(engine);
    setChanges(new Map());
  }
  const { imports, clears } = splitChanges(changes);
  const applying = useMutation({
    mutationFn: async () => {
      if (imports.length > 0) {
        await importSessions(
          engine,
          imports.map((s) => s.file),
        );
        setChanges((prev) => withoutApplied(prev, imports));
      }
      if (clears.length > 0) {
        await runSessionAction(
          'clear',
          clears.map((s) => s.id),
        );
        setChanges((prev) => withoutApplied(prev, clears));
      }
      return { imported: imports.length, cleared: clears.length };
    },
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['session-import', engine] }),
        client.invalidateQueries({ queryKey: ['sessions'] }),
      ]);
    },
  });
  return (
    <section aria-label="Import" className="flex flex-col gap-2" data-testid="import-panel">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold">Import</h2>
        <p className="text-xs text-muted-foreground">
          Checked sessions appear in the table below. Check to import, uncheck to clear, then click
          Apply.
        </p>
        <div className="ml-auto flex items-center gap-3">
          {applying.isError && (
            <p role="alert" className="text-xs whitespace-pre-wrap text-destructive">
              Apply failed: {applying.error.message}
            </p>
          )}
          {applying.isSuccess && changes.size === 0 && (
            <p className="text-xs text-muted-foreground" data-testid="import-result">
              {[
                ...(applying.data.imported > 0
                  ? [`Imported ${String(applying.data.imported)}`]
                  : []),
                ...(applying.data.cleared > 0 ? [`Cleared ${String(applying.data.cleared)}`] : []),
              ].join(', ')}
            </p>
          )}
          {changes.size > 0 && (
            <Button
              variant="ghost"
              size="sm"
              data-testid="import-undo"
              disabled={applying.isPending}
              onClick={() => {
                setChanges(new Map());
              }}
            >
              <Undo2 />
              Undo changes
            </Button>
          )}
          <Button
            size="sm"
            data-testid="import-apply"
            disabled={changes.size === 0 || applying.isPending}
            onClick={() => {
              applying.mutate();
            }}
          >
            <Check />
            {applying.isPending ? 'Applying…' : applyLabel(imports.length, clears.length)}
          </Button>
        </div>
      </div>
      <ImportColumns engine={engine} mode="manage" changes={changes} onChanges={setChanges} />
    </section>
  );
}

// Bottom: the manage table. Selected sessions: clear, delete, archive and restore, or analyze together (local
// config ones or ones bound to the same variant; the analysis form checks). The ids to analyze go into this tab's
// sessionStorage and the URL carries only a key (Contracts 25.5)
function SessionList({ engine }: { engine: SessionEngine }) {
  const navigate = useNavigate();
  return (
    <SessionManager
      engine={engine}
      actions={(targets, done) => (
        <>
          <SessionActionButtons targets={[...targets]} onDone={done} />
          <Button
            size="sm"
            onClick={() => {
              void navigate(`/analyses/new?picked=${rememberPicked(targets.map((t) => t.id))}`);
            }}
          >
            Analyze these sessions
          </Button>
        </>
      )}
    />
  );
}

export function SessionsPage() {
  useSessionEvents();
  const [engine, setEngine] = useSessionEngine();
  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">Sessions</h1>
          <p className="text-sm text-muted-foreground">
            Import sessions from disk above; view, analyze and manage imported sessions below.
          </p>
        </div>
        <EngineChoice value={engine} onChange={setEngine} order={SESSION_ORDER} label="View" />
      </header>
      <ImportPanel engine={engine} />
      <SessionList engine={engine} />
    </div>
  );
}
