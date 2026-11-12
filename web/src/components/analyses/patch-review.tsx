import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { EditableDiffEditor } from '@/components/analyses/editable-diff-editor';
import {
  countChanges,
  DiffCounts,
  DiffFileCard,
  DiffViewTypeToggle,
  hunksOfBlocks,
  useDiffViewType,
} from '@/components/diff';
import { FullscreenArea, FullscreenButton, useFullscreen } from '@/components/fullscreen';
import { RenderedCompare } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import {
  applyHunks,
  type FileProposal,
  type Finding,
  type Hunk,
  saveAnalysisVariant,
} from '@/lib/analyses-api';
import { cn } from '@/lib/utils';

type Decision = 'accepted' | 'rejected';

interface FileState {
  decisions: Record<number, Decision>;
  // Content after editing in the editor; null when it equals the result of the selections
  edited: string | null;
}

const resultOf = (file: FileProposal, state: FileState) =>
  state.edited ??
  applyHunks(
    file.original,
    file.hunks.filter((h) => state.decisions[h.index] === 'accepted'),
  );

// The row above a hunk: position, added/removed lines, related findings, accept and reject
function HunkHeader({
  hunk,
  decision,
  findings,
  locked,
  onDecide,
}: {
  hunk: Hunk;
  decision: Decision | undefined;
  findings: Finding[];
  locked: boolean;
  onDecide: (d: Decision) => void;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 border-y bg-muted/50 px-3 py-1 text-xs',
        decision === 'accepted' && 'bg-success-muted',
      )}
      data-testid="hunk"
      data-decision={decision ?? 'pending'}
      data-dimmed={decision === 'rejected'}
    >
      <span className="shrink-0 font-medium">Line {hunk.start + 1}</span>
      <DiffCounts additions={hunk.insert.length} deletions={hunk.remove.length} />
      <ul className="flex min-w-0 flex-1 flex-wrap gap-x-3">
        {findings.map((f) => (
          <li key={f.findingId} className="max-w-full truncate" title={f.title}>
            <a className="underline" href={`#finding-${f.findingId}`}>
              {f.findingId}
            </a>{' '}
            {f.title}
          </li>
        ))}
      </ul>
      <div className="flex shrink-0 gap-1">
        <Button
          size="xs"
          variant={decision === 'accepted' ? 'default' : 'outline'}
          disabled={locked}
          onClick={() => {
            onDecide('accepted');
          }}
        >
          Accept
        </Button>
        <Button
          size="xs"
          variant={decision === 'rejected' ? 'secondary' : 'outline'}
          disabled={locked}
          onClick={() => {
            onDecide('rejected');
          }}
        >
          Reject
        </Button>
      </div>
    </div>
  );
}

// Edits present at mount become the editor's initial content; while editing, hunk choices are locked and fromHunks does not change
function FileEditor({
  file,
  fromHunks,
  edited,
  onChange,
}: {
  file: FileProposal;
  fromHunks: string;
  edited: string | null;
  onChange: (value: string) => void;
}) {
  const [initial] = useState(edited);
  return (
    <EditableDiffEditor
      path={file.path}
      original={file.original}
      modified={initial ?? fromHunks}
      onChange={onChange}
    />
  );
}

type Mode = 'hunks' | 'rendered' | 'edit';

const modeLabels: Record<Mode, string> = {
  hunks: 'Hunks',
  rendered: 'Rendered',
  edit: 'Edit result',
};

// Contracts 15.3, 21.3: each file's suggested changes shown as a red/green diff, accepted or rejected hunk by hunk;
// .md files have a rendered comparison; the accepted result can be edited further in a Monaco diff view; saved as a draft variant
export function PatchReview({
  analysisId,
  files,
  findings,
  patches,
}: {
  analysisId: string;
  files: FileProposal[];
  findings: Finding[];
  patches: { file: string; rationale: string; findingIds: string[] }[];
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const fullscreen = useFullscreen();
  const [viewType] = useDiffViewType();
  const [states, setStates] = useState<Record<string, FileState>>({});
  // Editor rebuild count per file: incremented when edits are discarded
  const [revisions, setRevisions] = useState<Record<string, number>>({});
  const [current, setCurrent] = useState(files[0]?.path ?? '');
  const [selectedMode, setMode] = useState<Mode>('hunks');
  const [name, setName] = useState(`From analysis ${analysisId}`);
  const [description, setDescription] = useState('');
  const stateOf = (path: string): FileState => states[path] ?? { decisions: {}, edited: null };
  const changed = files
    .map((f) => ({ path: f.path, content: resultOf(f, stateOf(f.path)), original: f.original }))
    .filter((f) => f.content !== f.original);
  const save = useMutation({
    mutationFn: () =>
      saveAnalysisVariant(analysisId, {
        name,
        description,
        files: changed.map(({ path, content }) => ({ path, content })),
      }),
    onSuccess: async (created) => {
      await client.invalidateQueries({ queryKey: ['variants'] });
      void navigate(`/variants/${created.id}`);
    },
  });
  const file = files.find((f) => f.path === current) ?? files[0];
  const diff = useMemo(() => {
    if (file === undefined) return null;
    const hunks = hunksOfBlocks(file.original, file.hunks);
    return {
      path: file.path,
      status: file.original === '' ? ('added' as const) : ('modified' as const),
      hunks,
      ...countChanges(hunks),
    };
  }, [file]);

  if (file === undefined || diff === null) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Suggested changes</h2>
        <p className="text-sm text-muted-foreground">The synthesis step suggested no changes.</p>
      </section>
    );
  }
  const state = stateOf(file.path);
  const fromHunks = resultOf(file, { ...state, edited: null });
  const update = (next: FileState) => {
    setStates((prev) => ({ ...prev, [file.path]: next }));
  };
  // Editor content changed (including changes Monaco emits when selections update the content): compare with
  // the result of the current selections, computed from the latest state, not the stale state in the callback closure
  const edit = (value: string) => {
    setStates((prev) => {
      const now = prev[file.path] ?? { decisions: {}, edited: null };
      const edited = value === resultOf(file, { ...now, edited: null }) ? null : value;
      return edited === now.edited ? prev : { ...prev, [file.path]: { ...now, edited } };
    });
  };
  const rationale = patches.filter((p) => `skills/${p.file}` === file.path);
  const markdown = file.path.endsWith('.md');
  const modes: Mode[] = markdown ? ['hunks', 'rendered', 'edit'] : ['hunks', 'edit'];
  const mode = modes.includes(selectedMode) ? selectedMode : 'hunks';

  return (
    <FullscreenArea
      active={fullscreen.active}
      testId="patch-review"
      className="flex flex-col gap-2"
      activeClassName="p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">Suggested changes</h2>
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Changed files">
          {files.map((f) => {
            const decided = Object.keys(stateOf(f.path).decisions).length;
            return (
              <button
                key={f.path}
                type="button"
                role="tab"
                aria-selected={f.path === file.path}
                className="rounded-md border px-2.5 py-1 font-mono text-xs aria-selected:border-foreground aria-selected:bg-muted"
                onClick={() => {
                  setCurrent(f.path);
                }}
              >
                {f.path}
                <span className="ml-2 text-muted-foreground">
                  {decided}/{f.hunks.length}
                </span>
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {mode === 'hunks' && <DiffViewTypeToggle />}
          <div
            role="group"
            aria-label="View"
            className="inline-flex overflow-hidden rounded-md border text-xs"
            data-testid="patch-mode"
            data-mode={mode}
          >
            {modes.map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                className="px-2.5 py-1 hover:bg-muted aria-pressed:bg-foreground aria-pressed:text-background"
                onClick={() => {
                  setMode(m);
                }}
              >
                {modeLabels[m]}
              </button>
            ))}
          </div>
          <FullscreenButton active={fullscreen.active} onToggle={fullscreen.toggle} size="xs" />
        </div>
      </div>
      {rationale.map((p, i) => (
        <p key={i} className="text-sm text-muted-foreground">
          {p.rationale}
        </p>
      ))}
      {state.edited !== null && (
        <div className="flex items-center gap-2 rounded-md border border-warning-border bg-warning px-3 py-1.5 text-xs text-warning-foreground">
          Edited in the editor. Discard the edits to choose hunks again.
          <Button
            size="xs"
            variant="outline"
            className="ml-auto"
            onClick={() => {
              update({ ...state, edited: null });
              setRevisions({ ...revisions, [file.path]: (revisions[file.path] ?? 0) + 1 });
            }}
          >
            Discard edits
          </Button>
        </div>
      )}
      <div
        className={cn(
          'min-h-0 overflow-hidden rounded-md border',
          fullscreen.active ? 'flex-1' : 'h-[calc(100svh-11rem)] min-h-[28rem]',
        )}
        data-testid="patch-work"
      >
        {mode === 'hunks' && (
          <div className="h-full overflow-auto" data-testid="patch-hunks">
            <DiffFileCard
              key={file.path}
              file={diff}
              viewType={viewType}
              source={file.original}
              className="rounded-none border-0"
              renderHunkHeader={(_, i) => {
                const hunk = file.hunks[i];
                if (hunk === undefined) throw new Error(`${file.path} has no hunk ${String(i)}`);
                return (
                  <HunkHeader
                    hunk={hunk}
                    decision={state.decisions[hunk.index]}
                    locked={state.edited !== null}
                    findings={findings.filter((f) => hunk.findingIds.includes(f.findingId))}
                    onDecide={(d) => {
                      update({ ...state, decisions: { ...state.decisions, [hunk.index]: d } });
                    }}
                  />
                );
              }}
            />
          </div>
        )}
        {mode === 'rendered' && (
          <RenderedCompare
            key={file.path}
            path={file.path}
            original={file.original}
            modified={file.proposed}
            changes={file.hunks}
            labels={['Original', 'With all suggestions']}
          />
        )}
        {mode === 'edit' && (
          <div className="h-full" data-testid="patch-editor">
            {/* The editor keeps its own input: the content passed in changes only with accept/reject, and edits are not passed back
                (with fast typing an old value would overwrite new input). Returning after switching file or view uses the edits
                present at mount; discarding edits changes the key to rebuild the editor */}
            <FileEditor
              key={`${file.path}:${String(revisions[file.path] ?? 0)}`}
              file={file}
              fromHunks={fromHunks}
              edited={state.edited}
              onChange={edit}
            />
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2">
        <label className="flex items-center gap-2 text-sm">
          New variant name
          <input
            aria-label="New variant name"
            className="h-8 w-64 rounded-md border bg-background px-2 text-sm"
            value={name}
            required
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </label>
        <label className="flex min-w-64 flex-1 items-center gap-2 text-sm">
          Description
          <input
            aria-label="New variant description"
            className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
            placeholder="What this version changes"
            value={description}
            required
            onChange={(e) => {
              setDescription(e.target.value);
            }}
          />
        </label>
        <Button
          disabled={
            changed.length === 0 ||
            name.trim() === '' ||
            description.trim() === '' ||
            save.isPending
          }
          onClick={() => {
            save.mutate();
          }}
        >
          {save.isPending ? 'Saving…' : 'Save as variant'}
        </Button>
        <span className="text-xs text-muted-foreground" data-testid="changed-files">
          {changed.length === 0
            ? 'No changes accepted yet'
            : `${String(changed.length)} ${changed.length === 1 ? 'file' : 'files'} changed. Saving does not build; build it on the variant page`}
        </span>
        {save.isError && (
          <p role="alert" className="w-full text-sm text-destructive">
            {save.error.message}
          </p>
        )}
      </div>
    </FullscreenArea>
  );
}
