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

// skill 浏览（Contracts 26.3）：左侧是工作目录 src/skills 的文件树，标出相对底子新增、修改、删除的文件；右侧是选中
// 文件的内容（.md 渲染或源码，其他文件语法高亮），"对比"显示相对底子、上次保存或上一版的 diff（28.4）。只读：编辑由 agent 做

const markLetter: Record<WorkspaceFileStatus, string | null> = {
  added: 'A',
  modified: 'M',
  removed: 'D',
  unchanged: null,
};
const markTitle: Record<WorkspaceFileStatus, string> = {
  added: '新增',
  modified: '修改',
  removed: '删除',
  unchanged: '未变',
};

interface TreeDir {
  name: string;
  path: string;
  dirs: TreeDir[];
  files: { name: string; path: string; status: WorkspaceFileStatus }[];
}

// 路径形如 skills/<skill>/...；树从 skills/ 之下开始
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
    return <p className="p-2 text-xs text-muted-foreground">没有文件。</p>;
  }
  return (
    <ul className="text-xs" data-testid="ws-tree">
      <TreeView dir={tree} depth={0} selected={selected} onSelect={onSelect} />
    </ul>
  );
}

// 1 起的闭区间：新内容中相对上一份新增或改动的行
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

// 改动处高亮的时长
const FLASH_MS = 3_000;

// 当前文件被 agent 改了：内容原地更新，改动的行短暂高亮
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

// 其他文件与 .md 的源码：highlight.js 高亮；改动的行在下面垫一层底色
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
        {/* highlight.js 的输出已转义 */}
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
  base: '与底子相同。',
  saved: '与上次保存相同。',
  previous: '与上一版相同。',
};
// 内容区比这窄时 frontmatter 显示为纵向的「键：值」列表，表格的每一列都放不下
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

// 右侧：选中文件的内容或相对所选对象（底子、上次保存、上一版）的 diff
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
  // "对比"可以选的对象（againstOptions）
  against: readonly AgainstOption[];
  // 工具栏最右边（跟随 agent 的开关）
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
  // 刷新期间保留上一份内容，不闪成"加载中"
  const content = file.data?.path === path ? file.data.content : null;
  const flash = useFlash(path ?? '', content);
  const isMd = path?.endsWith('.md') === true;
  const [bodyRef, bodySize] = useSize();

  let body;
  if (path === null) {
    body = <p className="p-3 text-sm text-muted-foreground">在左侧或流程图中选一个文件。</p>;
  } else if (compare === 'on') {
    body =
      target === null ? (
        <p className="p-3 text-sm text-muted-foreground" data-testid="ws-diff-none">
          还没有可以对比的版本。
        </p>
      ) : diff.data === undefined ? (
        <p className="p-3 text-sm text-muted-foreground">
          {diff.isError ? diff.error.message : '加载中…'}
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
    body = <p className="p-3 text-sm text-muted-foreground">加载中…</p>;
  } else if (file.data.binary) {
    body = <p className="p-3 text-sm text-muted-foreground">二进制文件，不显示内容。</p>;
  } else if (content === null) {
    body = (
      <p className="p-3 text-sm text-muted-foreground" data-testid="ws-file-deleted">
        已删除{status === 'removed' ? '（底子中有，打开"对比"查看删除的内容）' : ''}。
      </p>
    );
  } else if (isMd && mdView === 'rendered') {
    body = (
      // 容器查询：更窄时 frontmatter 的键与值分两行（markdown.css）
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
          <div role="group" aria-label="显示方式" className="inline-flex gap-1">
            <Toggle
              pressed={mdView === 'rendered'}
              testId="ws-md-rendered"
              onToggle={() => {
                setMdView('rendered');
              }}
            >
              渲染
            </Toggle>
            <Toggle
              pressed={mdView === 'source'}
              testId="ws-md-source"
              onToggle={() => {
                setMdView('source');
              }}
            >
              源码
            </Toggle>
          </div>
        )}
        {compare === 'on' && <DiffViewTypeToggle />}
        <Toggle
          pressed={compare === 'on'}
          testId="ws-compare"
          title="显示这个文件的改动"
          onToggle={() => {
            setCompare(compare === 'on' ? 'off' : 'on');
          }}
        >
          对比
        </Toggle>
        {compare === 'on' && target !== null && (
          <select
            aria-label="对比的对象"
            className="h-6 rounded-md border bg-background px-1 text-xs"
            data-testid="ws-against"
            value={target}
            onChange={(event) => {
              const next = against.find((o) => o.value === event.target.value);
              if (next === undefined) throw new Error(`未知的对比对象：${event.target.value}`);
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
