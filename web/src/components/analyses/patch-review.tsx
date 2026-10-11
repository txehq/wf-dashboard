import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { EditableDiffEditor } from '@/components/analyses/editable-diff-editor';
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

function HunkItem({
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
    <li
      className={cn(
        'flex flex-col gap-2 rounded-md border px-3 py-2 text-xs',
        decision === 'accepted' && 'border-emerald-400 bg-emerald-50/50',
        decision === 'rejected' && 'opacity-60',
      )}
      data-testid="hunk"
      data-decision={decision ?? 'pending'}
    >
      <div className="flex items-center gap-2">
        <span className="font-medium">第 {hunk.start + 1} 行</span>
        <span className="text-muted-foreground">
          −{hunk.remove.length} +{hunk.insert.length}
        </span>
        <div className="ml-auto flex gap-1">
          <Button
            size="sm"
            variant={decision === 'accepted' ? 'default' : 'outline'}
            disabled={locked}
            onClick={() => {
              onDecide('accepted');
            }}
          >
            接受
          </Button>
          <Button
            size="sm"
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
      <pre className="max-h-48 overflow-auto rounded bg-muted/60 px-2 py-1 font-mono text-[11px] whitespace-pre-wrap">
        {hunk.remove.map((l) => `- ${l}`).join('')}
        {hunk.insert.map((l) => `+ ${l}`).join('')}
      </pre>
      {findings.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {findings.map((f) => (
            <li key={f.findingId}>
              <a className="underline" href={`#finding-${f.findingId}`}>
                {f.findingId}
              </a>{' '}
              {f.title}
            </li>
          ))}
        </ul>
      )}
    </li>
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

// Contracts 15.3：每个文件一个 diff 视图，按 hunk 逐处接受或拒绝，接受后的结果可以继续编辑；另存为草稿 variant
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
  const [states, setStates] = useState<Record<string, FileState>>({});
  // 每个文件的编辑器重建次数：撤销编辑时加一
  const [revisions, setRevisions] = useState<Record<string, number>>({});
  const [current, setCurrent] = useState(files[0]?.path ?? '');
  const [name, setName] = useState(`来自分析 ${analysisId}`);
  const stateOf = (path: string): FileState => states[path] ?? { decisions: {}, edited: null };
  const changed = files
    .map((f) => ({ path: f.path, content: resultOf(f, stateOf(f.path)), original: f.original }))
    .filter((f) => f.content !== f.original);
  const save = useMutation({
    mutationFn: () =>
      saveAnalysisVariant(analysisId, {
        name: name.trim(),
        files: changed.map(({ path, content }) => ({ path, content })),
      }),
    onSuccess: async (created) => {
      await client.invalidateQueries({ queryKey: ['variants'] });
      void navigate(`/variants/${created.id}`);
    },
  });

  if (files.length === 0) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">修改建议</h2>
        <p className="text-sm text-muted-foreground">综合步骤没有提出修改建议。</p>
      </section>
    );
  }
  const file = files.find((f) => f.path === current) ?? files[0];
  if (file === undefined) throw new Error('修改建议为空');
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

  return (
    <section aria-label="修改建议" className="flex flex-col gap-3" data-testid="patch-review">
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
              className="rounded-md border px-3 py-1.5 font-mono text-xs aria-selected:border-foreground aria-selected:bg-muted"
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
      {rationale.map((p, i) => (
        <p key={i} className="text-sm text-muted-foreground">
          {p.rationale}
        </p>
      ))}
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="h-[36rem] min-w-0 rounded-md border" data-testid="patch-editor">
          {/* 编辑器自己保存输入：传入的内容只随接受与拒绝变化，不把每次编辑的内容再传回去（快速输入时旧的值会覆盖新的输入）。
              切换文件后回来时以挂载时已有的编辑为准；撤销编辑时换 key 重建编辑器 */}
          <FileEditor
            key={`${file.path}:${String(revisions[file.path] ?? 0)}`}
            file={file}
            fromHunks={fromHunks}
            edited={state.edited}
            onChange={edit}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          {state.edited !== null && (
            <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs">
              已在编辑器中修改；撤销编辑后才能重新选择各处修改。
              <Button
                size="sm"
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
          <ul className="flex max-h-[36rem] flex-col gap-2 overflow-y-auto" aria-label="逐处修改">
            {file.hunks.map((h) => (
              <HunkItem
                key={h.index}
                hunk={h}
                decision={state.decisions[h.index]}
                locked={state.edited !== null}
                findings={findings.filter((f) => h.findingIds.includes(f.findingId))}
                onDecide={(d) => {
                  update({ ...state, decisions: { ...state.decisions, [h.index]: d } });
                }}
              />
            ))}
          </ul>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3">
        <label className="flex items-center gap-2 text-sm">
          新 variant 的名称
          <input
            aria-label="新 variant 的名称"
            className="h-8 w-80 rounded-md border bg-background px-2 text-sm"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </label>
        <Button
          disabled={changed.length === 0 || name.trim() === '' || save.isPending}
          onClick={() => {
            save.mutate();
          }}
        >
          {save.isPending ? '正在保存…' : '另存为 variant'}
        </Button>
        <span className="text-xs text-muted-foreground" data-testid="changed-files">
          {changed.length === 0
            ? '还没有接受任何修改'
            : `${String(changed.length)} 个文件有修改；保存为草稿，构建与评测由你发起`}
        </span>
        {save.isError && (
          <p role="alert" className="w-full text-sm text-destructive">
            {save.error.message}
          </p>
        )}
      </div>
    </section>
  );
}
