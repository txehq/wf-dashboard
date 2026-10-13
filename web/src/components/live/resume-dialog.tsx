import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ModelEffortChoice } from '@/components/model-effort';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';
import {
  isBuiltVariant,
  type LiveDetail,
  type LiveDriver,
  resumeDefaultsQuery,
  resumeLive,
  type ResumePlan,
  resumePlanQuery,
} from '@/lib/live-api';
import type { ModelEffort } from '@/lib/model-effort';
import type { ResumeCopy } from '@wf-dashboard/server/live/views';
import { variantLabel, variantsQuery } from '@/pages/variants-api';

const LOCAL = 'local';

export function DriverChoice({
  value,
  onChange,
  name,
}: {
  value: LiveDriver;
  onChange: (driver: LiveDriver) => void;
  name: string;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-sm font-medium">初始驾驶者</legend>
      {(
        [
          ['human', '人'],
          ['simulated', '模拟用户'],
        ] as const
      ).map(([driver, label]) => (
        <label key={driver} className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name={name}
            checked={value === driver}
            onChange={() => {
              onChange(driver);
            }}
          />
          {label}
        </label>
      ))}
    </fieldset>
  );
}

// 一份 jsonl 的摘要：路径、最后一条消息的时间与内容
function CopySummary({ label, copy }: { label: string; copy: ResumeCopy }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border px-3 py-2 text-xs">
      <span className="font-medium">{label}</span>
      <span className="font-mono break-all text-muted-foreground">{copy.path}</span>
      <span>
        最后一条
        {copy.lastRole === 'user'
          ? '（你说的）'
          : copy.lastRole === 'assistant'
            ? '（agent 说的）'
            : ''}
        {copy.lastAt === null ? '' : `，${formatDateTime(copy.lastAt)}`}：
        {copy.lastText ?? '（没有消息）'}
      </span>
    </div>
  );
}

// 预检的结果（Contracts 14.5）：对话框打开与改选配置时就说明 resume 会做什么，或为什么不能 resume
function PlanNotice({ plan }: { plan: ResumePlan }) {
  const box = 'flex flex-col gap-2 rounded-md border px-3 py-2 text-sm';
  if (plan.action === 'blocked') {
    return (
      <div className={`${box} border-destructive`} data-testid="resume-plan" data-action="blocked">
        <span className="font-medium text-destructive">不能 resume</span>
        <ul className="flex list-disc flex-col gap-1 pl-5">
          {plan.problems.map((p) => (
            <li key={p.code} data-problem={p.code}>
              {p.message}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  const notes = plan.notes.map((n) => (
    <span key={n} className="text-xs text-muted-foreground">
      {n}
    </span>
  ));
  if (plan.action === 'diverged') {
    if (plan.latest === null || plan.target === null) throw new Error('分叉的预检缺少两份的摘要');
    return (
      <div className={`${box} border-amber-500`} data-testid="resume-plan" data-action="diverged">
        <span className="font-medium">这个配置中的那份与最新的不一致</span>
        <span className="text-xs">
          两份从某一处起各自接着写过。「以最新的为准继续」会把这个配置中的那份改名保留（.diverged-时间），
          再用最新的接着运行。
        </span>
        <CopySummary label="最新的一份" copy={plan.latest} />
        <CopySummary label="这个配置中的一份" copy={plan.target} />
        {notes}
      </div>
    );
  }
  const text = {
    resume: '在这个配置中直接接着运行。',
    copy: '先把 session 复制进这个配置，再接着运行；原文件不动。',
    sync: '这个配置中有一份较早的记录：先用最新的内容覆盖它，再接着运行。',
  }[plan.action];
  return (
    <div className={box} data-testid="resume-plan" data-action={plan.action}>
      <span>{text}</span>
      {notes}
    </div>
  );
}

function ResumeForm({
  sessionId,
  onClose,
  onResumed,
  navigateAfter,
}: {
  sessionId: string;
  onClose: () => void;
  onResumed: (live: LiveDetail) => void;
  // Sessions 详情中：resume 后打开交互区并选中这一项
  navigateAfter: boolean;
}) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const defaults = useQuery(resumeDefaultsQuery(sessionId));
  const variants = useQuery(variantsQuery);
  const [variant, setVariant] = useState<string | null>(null);
  const [driver, setDriver] = useState<LiveDriver>('human');
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const built = variants.data?.filter(isBuiltVariant) ?? [];
  // 默认为 session 所用的 variant（它不在构建成功的列表中时为本机配置）
  const used = built.some((v) => v.id === defaults.data?.variantId)
    ? (defaults.data?.variantId ?? null)
    : null;
  const chosen = variant ?? used ?? LOCAL;
  const variantId = chosen === LOCAL ? null : chosen;
  const plan = useQuery({
    ...resumePlanQuery(sessionId, variantId),
    enabled: defaults.data !== undefined && variants.data !== undefined,
  });
  const resuming = useMutation({
    mutationFn: resumeLive,
    onSuccess: async (live) => {
      await client.invalidateQueries({ queryKey: ['live'] });
      onResumed(live);
      if (navigateAfter) await navigate(`/live?item=${live.id}`);
    },
  });
  if (defaults.data === undefined || variants.data === undefined) {
    const error = defaults.error ?? variants.error;
    return error === null ? (
      <p className="text-sm text-muted-foreground">加载中…</p>
    ) : (
      <p role="alert" className="text-sm text-destructive">
        {error.message}
      </p>
    );
  }
  // 选了 variant 时的 model 与 effort：没有改选时为预检返回的默认值（设置的 agentModel、agentEffort）
  const chosenModel: ModelEffort | null =
    plan.data?.model == null || plan.data.effort === null
      ? null
      : {
          model: (model ?? plan.data.model) as ModelEffort['model'],
          effort: (effort ?? plan.data.effort) as ModelEffort['effort'],
        };
  const p = plan.data;
  const submit = (onDiverged?: 'use-latest') => {
    resuming.mutate({
      sessionId,
      variantId,
      driver,
      // 本机配置不传 --model 与 --effort
      ...(variantId === null || chosenModel === null ? {} : chosenModel),
      ...(onDiverged === undefined ? {} : { onDiverged }),
    });
  };
  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">配置</span>
        <select
          className="h-9 rounded-md border bg-background px-2"
          value={chosen}
          data-testid="resume-variant"
          onChange={(event) => {
            setVariant(event.target.value);
          }}
        >
          {built.map((v) => (
            <option key={v.id} value={v.id}>
              {variantLabel(v)}
            </option>
          ))}
          <option value={LOCAL}>本机配置（~/.claude）</option>
        </select>
      </label>
      <div className="flex flex-col gap-1 text-sm">
        <span className="font-medium">环境与工作目录</span>
        <span>real：在下面的真实目录中运行，用本机的 GitHub 与 Linear 凭据，写入不加限制。</span>
        <span className="font-mono text-xs break-all" data-testid="resume-cwd">
          {defaults.data.cwd ?? '（session 没有记录工作目录）'}
        </span>
      </div>
      <DriverChoice value={driver} onChange={setDriver} name={`resume-driver-${sessionId}`} />
      {variantId !== null && (
        <ModelEffortChoice
          value={chosenModel}
          onModel={setModel}
          onEffort={setEffort}
          testIdPrefix="resume"
        />
      )}
      {p === undefined ? (
        plan.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {plan.error.message}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">正在检查…</p>
        )
      ) : (
        <PlanNotice plan={p} />
      )}
      {resuming.isError && (
        <p role="alert" className="text-sm text-destructive">
          {resuming.error.message}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          取消
        </Button>
        {p?.action === 'diverged' ? (
          <Button
            data-testid="resume-use-latest"
            disabled={resuming.isPending || (variantId !== null && chosenModel === null)}
            onClick={() => {
              submit('use-latest');
            }}
          >
            <RotateCcw />
            {resuming.isPending ? '正在启动…' : '以最新的为准继续'}
          </Button>
        ) : (
          <Button
            data-testid="resume-confirm"
            disabled={
              p === undefined ||
              p.action === 'blocked' ||
              resuming.isPending ||
              (variantId !== null && chosenModel === null)
            }
            onClick={() => {
              submit();
            }}
          >
            <RotateCcw />
            {resuming.isPending ? '正在启动…' : 'resume'}
          </Button>
        )}
      </div>
    </div>
  );
}

// Sessions 详情与交互区的"resume"按钮（Contracts 14.5）：session 所属的项有运行中的进程时不可点。
// onResumed 由交互区传入（选中这一项的标签页）；不传时打开交互区并选中它
export function ResumeButton({
  sessionId,
  onResumed,
}: {
  sessionId: string;
  onResumed?: (live: LiveDetail) => void;
}) {
  const [open, setOpen] = useState(false);
  const defaults = useQuery(resumeDefaultsQuery(sessionId));
  const running = defaults.data?.running === true;
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        data-testid="resume-open"
        disabled={defaults.data === undefined || running}
        title={running ? '这个 session 正在交互区运行' : undefined}
        onClick={() => {
          setOpen(true);
        }}
      >
        <RotateCcw />
        resume
      </Button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="resume 这个 session"
            className="flex w-[32rem] max-w-[90vw] flex-col gap-4 rounded-lg border bg-background p-5 shadow-lg"
            data-testid="resume-dialog"
          >
            <h2 className="text-base font-semibold">resume 这个 session</h2>
            <p className="font-mono text-xs text-muted-foreground">{sessionId}</p>
            <ResumeForm
              sessionId={sessionId}
              onResumed={(live) => {
                setOpen(false);
                onResumed?.(live);
              }}
              navigateAfter={onResumed === undefined}
              onClose={() => {
                setOpen(false);
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}
