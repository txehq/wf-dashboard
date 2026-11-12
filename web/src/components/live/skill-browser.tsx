import { useQuery } from '@tanstack/react-query';
import { diffLines } from 'diff';
import hljs from 'highlight.js/lib/common';
import { ChevronDown, ChevronRight, FileText, Folder } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { DiffViewTypeToggle } from '@/components/diff';
import { Markdown } from '@/components/markdown';
import { SourceDiff } from '@/components/source-diff';
import { cn } from '@/lib/utils';
import { useSize } from '@/lib/use-size';
import {
  type AgainstOption,
  chosenAgainst,
  type Workspace,
  type WorkspaceAgainst,
  workspaceDiffQuery,
  workspaceFileQuery,
  type WorkspaceFileStatus,
} from '@/lib/workspace-api';

// Skill browser (Contracts 26.3): on the left, the file tree of src/skills in the working directory,
// marking files added, modified or removed relative to the base; on the right, the selected file's
// content (.md rendered or as source, other files syntax-highlighted), and "Compare" shows the diff
// against the base, the last save or the previous version (28.4). Read-only: the agent does the editing

const markLetter: Record<WorkspaceFileStatus, string | null> = {
  added: 'A',
  modified: 'M',
  removed: 'D',
  unchanged: null,
};
const markTitle: Record<WorkspaceFileStatus, string> = {
  added: 'Added',
  modified: 'Modified',
  removed: 'Removed',
  unchanged: 'Unchanged',
};

interface TreeDir {
  name: string;
  path: string;
  dirs: TreeDir[];
  files: { name: string; path: string; status: WorkspaceFileStatus }[];
}

// Paths look like skills/<skill>/...; the tree starts below skills/
function buildTree(files: Workspace['files']): TreeDir {
  const root: TreeDir = { name: '', path: 'skills', dirs: [], files: [] };
  for (const file of files) {
    const segments = file.path.split('/').slice(1);
    let dir = root;
    for (const segment of segments.slice(0, -1)) {
      const path = `${dir.path}/${segment}`;
      let next = dir.dirs.find((d) => d.path === path);
      if (next === undefined) {
        next = { name: segment, path, dirs: [], files: [] };
        dir.dirs.push(next);
      }
      dir = next;
    }
    dir.files.push({ name: segments.at(-1) ?? file.path, path: file.path, status: file.status });
  }
  return root;
}

function Mark({ status }: { status: WorkspaceFileStatus }) {
  const letter = markLetter[status];
  if (letter === null) return null;
  return (
    <span
      className={cn('ml-auto shrink-0 font-mono text-[11px] font-semibold', `ws-mark-${status}`)}
      title={markTitle[status]}
      data-testid="ws-file-mark"
    >
      {letter}
    </span>
  );
}

function TreeView({
  dir,
  depth,
  selected,
  onSelect,
}: {
  dir: TreeDir;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const indent = { paddingLeft: `${String(depth * 12 + 4)}px` };
  return (
    <li>
      {depth > 0 && (
        <button
          type="button"
          className="flex w-full items-center gap-1 rounded py-0.5 pr-1 text-left hover:bg-muted"
          style={indent}
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
        >
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          <Folder className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{dir.name}</span>
        </button>
      )}
      {open && (
        <ul>
          {dir.dirs.map((d) => (
            <TreeView
              key={d.path}
              dir={d}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
          {dir.files.map((f) => (
            <li key={f.path}>
              <button
                type="button"
                className={cn(
                  'flex w-full items-center gap-1 rounded py-0.5 pr-1 text-left hover:bg-muted aria-[current=true]:bg-muted aria-[current=true]:font-medium',
                  f.status === 'removed' && 'line-through decoration-1',
                )}
                style={{ paddingLeft: `${String((depth + 1) * 12 + 4)}px` }}
                aria-current={selected === f.path}
                data-testid="ws-file"
                data-path={f.path}
                data-status={f.status}
                title={f.path}
                onClick={() => {
                  onSelect(f.path);
                }}
              >
                <FileText className="size-3 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate">{f.name}</span>
                <Mark status={f.status} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function FileTree({
  files,
  selected,
  onSelect,
}: {
  files: Workspace['files'];
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const tree = useMemo(() => buildTree(files), [files]);
  if (files.length === 0) {
    return <p className="p-2 text-xs text-muted-foreground">No files.</p>;
  }
  return (
    <ul className="text-xs" data-testid="ws-tree">
      <TreeView dir={tree} depth={0} selected={selected} onSelect={onSelect} />
    </ul>
  );
}

// 1-based inclusive ranges: lines in the new content added or changed relative to the previous one
function changedLines(before: string, after: string): [number, number][] {
  const ranges: [number, number][] = [];
  let line = 1;
  for (const part of diffLines(before, after)) {
    const count = part.count;
    if (part.removed) continue;
    if (part.added) ranges.push([line, line + count - 1]);
    line += count;
  }
  return ranges;
}

// How long changes stay highlighted
const FLASH_MS = 3_000;

// When the agent changes the current file: content updates in place and changed lines briefly highlight
function useFlash(path: string, content: string | null) {
  const previous = useRef<{ path: string; content: string | null } | null>(null);
  const [flash, setFlash] = useState<[number, number][]>([]);
  useEffect(() => {
    const last = previous.current;
    previous.current = { path, content };
    if (last?.path !== path || last.content === null || content === null) {
      setFlash([]);
      return;
    }
    if (last.content === content) return;
    setFlash(changedLines(last.content, content));
    const timer = setTimeout(() => {
      setFlash([]);
    }, FLASH_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [path, content]);
  return flash;
}

const LINE_PX = 20;
const CODE_PAD_PX = 12;

function languageOf(path: string): string {
  const ext = path.split('.').at(-1) ?? '';
  return hljs.getLanguage(ext) === undefined ? 'plaintext' : ext;
}

// Source of other files and .md: highlighted by highlight.js; changed lines get a background layer beneath
function CodeView({
  path,
  content,
  flash,
}: {
  path: string;
  content: string;
  flash: [number, number][];
}) {
  const html = useMemo(
    () =>
      hljs.highlight(content, { language: path.endsWith('.md') ? 'markdown' : languageOf(path) })
        .value,
    [path, content],
  );
  return (
    <div className="relative min-w-max" data-testid="ws-code">
      {flash.map(([from, to]) => (
        <div
          key={`${String(from)}-${String(to)}`}
          aria-hidden
          className="absolute inset-x-0 bg-[var(--wfd-diff-add-line)]"
          data-testid="ws-flash"
          style={{
            top: CODE_PAD_PX + (from - 1) * LINE_PX,
            height: (to - from + 1) * LINE_PX,
          }}
        />
      ))}
      <pre
        className="relative m-0 font-mono text-xs"
        style={{ padding: CODE_PAD_PX, lineHeight: `${String(LINE_PX)}px` }}
      >
        {/* highlight.js output is already escaped */}
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

type MdView = 'rendered' | 'source';
const MD_VIEW_KEY = 'wfd.workspace.mdView';
const COMPARE_KEY = 'wfd.workspace.compare';
const AGAINST_KEY = 'wfd.workspace.against';
const sameAs: Record<WorkspaceAgainst, string> = {
  base: 'Same as the base.',
  saved: 'Same as the last save.',
  previous: 'Same as the previous version.',
};
// Below this content width, frontmatter shows as a vertical "key: value" list because table columns don't fit
const FRONTMATTER_TABLE_MIN = 520;

function useStored<T extends string>(key: string, values: readonly T[], initial: T) {
  const [value, setValue] = useState<T>(() => {
    const raw = localStorage.getItem(key);
    return values.find((v) => v === raw) ?? initial;
  });
  return [
    value,
    (next: T) => {
      localStorage.setItem(key, next);
      setValue(next);
    },
  ] as const;
}

function Toggle({
  pressed,
  onToggle,
  children,
  testId,
  title,
}: {
  pressed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  testId: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      data-testid={testId}
      title={title}
      className="rounded-md border px-2 py-0.5 text-xs whitespace-nowrap hover:bg-muted aria-pressed:bg-foreground aria-pressed:text-background"
      onClick={onToggle}
    >
      {children}
    </button>
  );
}

// Right side: the selected file's content, or its diff against the chosen target (base, last save,
// previous version)
export function FileContent({
  liveId,
  path,
  status,
  against,
  toolbarEnd,
}: {
  liveId: string;
  path: string | null;
  status: WorkspaceFileStatus | null;
  // Targets "Compare" can choose (againstOptions)
  against: readonly AgainstOption[];
  // Far right of the toolbar (the follow-agent switch)
  toolbarEnd: React.ReactNode;
}) {
  const [mdView, setMdView] = useStored<MdView>(MD_VIEW_KEY, ['rendered', 'source'], 'rendered');
  const [compare, setCompare] = useStored(COMPARE_KEY, ['on', 'off'], 'off');
  const [storedAgainst, setStoredAgainst] = useStored<WorkspaceAgainst>(
    AGAINST_KEY,
    ['base', 'saved', 'previous'],
    'base',
  );
  const target = chosenAgainst(against, storedAgainst);
  const file = useQuery({ ...workspaceFileQuery(liveId, path ?? ''), enabled: path !== null });
  const diff = useQuery({
    ...workspaceDiffQuery(liveId, path ?? '', target ?? 'base'),
    enabled: path !== null && compare === 'on' && target !== null,
  });
  // Keep the previous content while refreshing instead of flashing "Loading"
  const content = file.data?.path === path ? file.data.content : null;
  const flash = useFlash(path ?? '', content);
  const isMd = path?.endsWith('.md') === true;
  const [bodyRef, bodySize] = useSize();

  let body;
  if (path === null) {
    body = (
      <p className="p-3 text-sm text-muted-foreground">
        Select a file on the left or in the flowchart.
      </p>
    );
  } else if (compare === 'on') {
    body =
      target === null ? (
        <p className="p-3 text-sm text-muted-foreground" data-testid="ws-diff-none">
          No version to compare with yet.
        </p>
      ) : diff.data === undefined ? (
        <p className="p-3 text-sm text-muted-foreground">
          {diff.isError ? diff.error.message : 'Loading…'}
        </p>
      ) : (
        <div className="p-2" data-testid="ws-diff" data-against={diff.data.against}>
          <SourceDiff
            files={diff.data.status === 'unchanged' || diff.data.status === null ? [] : [diff.data]}
            empty={sameAs[diff.data.against]}
          />
        </div>
      );
  } else if (file.isError) {
    body = (
      <p role="alert" className="p-3 text-sm text-destructive">
        {file.error.message}
      </p>
    );
  } else if (file.data?.path !== path) {
    body = <p className="p-3 text-sm text-muted-foreground">Loading…</p>;
  } else if (file.data.binary) {
    body = <p className="p-3 text-sm text-muted-foreground">Binary file; content not shown.</p>;
  } else if (content === null) {
    body = (
      <p className="p-3 text-sm text-muted-foreground" data-testid="ws-file-deleted">
        {status === 'removed'
          ? 'Removed (it exists in the base; turn on "Compare" to see the removed content).'
          : 'Removed.'}
      </p>
    );
  } else if (isMd && mdView === 'rendered') {
    body = (
      // Container query: when narrower, frontmatter keys and values go on two lines (markdown.css)
      <div className="p-4 [container-type:inline-size]">
        <Markdown
          content={content}
          filePath={path}
          frontmatter={bodySize.width < FRONTMATTER_TABLE_MIN ? 'list' : 'table'}
          marks={flash.length === 0 ? undefined : { kind: 'added', lines: flash }}
        />
      </div>
    );
  } else {
    body = <CodeView path={path} content={content} flash={flash} />;
  }

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="ws-content"
      data-path={path ?? ''}
    >
      <div className="flex flex-wrap items-center gap-1.5 border-b px-2 py-1">
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs"
          title={path ?? ''}
          data-testid="ws-path"
        >
          {path ?? ''}
        </span>
        {isMd && compare === 'off' && (
          <div role="group" aria-label="View" className="inline-flex gap-1">
            <Toggle
              pressed={mdView === 'rendered'}
              testId="ws-md-rendered"
              onToggle={() => {
                setMdView('rendered');
              }}
            >
              Rendered
            </Toggle>
            <Toggle
              pressed={mdView === 'source'}
              testId="ws-md-source"
              onToggle={() => {
                setMdView('source');
              }}
            >
              Source
            </Toggle>
          </div>
        )}
        {compare === 'on' && <DiffViewTypeToggle />}
        <Toggle
          pressed={compare === 'on'}
          testId="ws-compare"
          title="Show this file's changes"
          onToggle={() => {
            setCompare(compare === 'on' ? 'off' : 'on');
          }}
        >
          Compare
        </Toggle>
        {compare === 'on' && target !== null && (
          <select
            aria-label="Compare with"
            className="h-6 rounded-md border bg-background px-1 text-xs"
            data-testid="ws-against"
            value={target}
            onChange={(event) => {
              const next = against.find((o) => o.value === event.target.value);
              if (next === undefined)
                throw new Error(`Unknown compare target: ${event.target.value}`);
              setStoredAgainst(next.value);
            }}
          >
            {against.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
        {toolbarEnd}
      </div>
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-auto">
        {body}
      </div>
    </div>
  );
}
