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
  // 在编辑器中改过之后的内容；与按选择生成的结果相同时为空
  edited: string | null;
}

const resultOf = (file: FileProposal, state: FileState) =>
  state.edited ??
  applyHunks(
    file.original,
    file.hunks.filter((h) => state.decisions[h.index] === 'accepted'),
  );

// 一处修改上方的一行：位置、增删行数、对应的发现、接受与拒绝
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
        decision === 'accepted' && 'bg-emerald-100/70 dark:bg-emerald-950',
      )}
      data-testid="hunk"
      data-decision={decision ?? 'pending'}
      data-dimmed={decision === 'rejected'}
    >
      <span className="shrink-0 font-medium">第 {hunk.start + 1} 行</span>
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
          接受
        </Button>
        <Button
          size="xs"
          variant={decision === 'rejected' ? 'secondary' : 'outline'}
          disabled={locked}
          onClick={() => {
            onDecide('rejected');
          }}
        >
          拒绝
        </Button>
      </div>
    </div>
  );
}

// 挂载时已有的编辑作为编辑器的初始内容；之后编辑期间 hunk 的选择被锁定，fromHunks 不变
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
  hunks: '逐处修改',
  rendered: '渲染后的对比',
  edit: '编辑结果',
};

// Contracts 15.3、21.3：每个文件的修改建议以红绿 diff 显示，按 hunk 逐处接受或拒绝；.md 文件可以看渲染后的对比；
// 接受后的结果可以在 Monaco 对比视图中继续编辑；另存为草稿 variant
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
  // 每个文件的编辑器重建次数：撤销编辑时加一
  const [revisions, setRevisions] = useState<Record<string, number>>({});
  const [current, setCurrent] = useState(files[0]?.path ?? '');
  const [selectedMode, setMode] = useState<Mode>('hunks');
  const [name, setName] = useState(`来自分析 ${analysisId}`);
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
        <h2 className="text-lg font-semibold">修改建议</h2>
        <p className="text-sm text-muted-foreground">综合步骤没有提出修改建议。</p>
      </section>
    );
  }
  const state = stateOf(file.path);
  const fromHunks = resultOf(file, { ...state, edited: null });
  const update = (next: FileState) => {
    setStates((prev) => ({ ...prev, [file.path]: next }));
  };
  // 编辑器内容变化（包括按选择更新内容时 Monaco 发出的变化）：与按当前选择生成的结果比较，
  // 用最新的状态计算，不受回调闭包中旧状态的影响
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
        <h2 className="text-lg font-semibold">修改建议</h2>
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="修改的文件">
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
            aria-label="显示方式"
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
        <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs">
          已在编辑器中修改；撤销编辑后才能重新选择各处修改。
          <Button
            size="xs"
            variant="outline"
            className="ml-auto"
            onClick={() => {
              update({ ...state, edited: null });
              setRevisions({ ...revisions, [file.path]: (revisions[file.path] ?? 0) + 1 });
            }}
          >
            撤销编辑
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
                if (hunk === undefined) throw new Error(`${file.path} 没有第 ${String(i)} 处修改`);
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
            labels={['原文', '全部建议应用后']}
          />
        )}
        {mode === 'edit' && (
          <div className="h-full" data-testid="patch-editor">
            {/* 编辑器自己保存输入：传入的内容只随接受与拒绝变化，不把每次编辑的内容再传回去（快速输入时旧的值会覆盖新的输入）。
                切换文件或显示方式后回来时以挂载时已有的编辑为准；撤销编辑时换 key 重建编辑器 */}
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
          新 variant 的名称
          <input
            aria-label="新 variant 的名称"
            className="h-8 w-64 rounded-md border bg-background px-2 text-sm"
            value={name}
            required
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </label>
        <label className="flex min-w-64 flex-1 items-center gap-2 text-sm">
          描述
          <input
            aria-label="新 variant 的描述"
            className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
            placeholder="这一版改了什么"
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
          {save.isPending ? '正在保存…' : '另存为 variant'}
        </Button>
        <span className="text-xs text-muted-foreground" data-testid="changed-files">
          {changed.length === 0
            ? '还没有接受任何修改'
            : `${String(changed.length)} 个文件有修改；保存后不构建，到 variant 页面再构建`}
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
