import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { isBuiltVariant, type LiveDriver, resumeDefaultsQuery, resumeLive } from '@/lib/live-api';
import { variantsQuery } from '@/pages/variants-api';

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

function ResumeForm({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const defaults = useQuery(resumeDefaultsQuery(sessionId));
  const variants = useQuery(variantsQuery);
  const [variant, setVariant] = useState<string | null>(null);
  const [driver, setDriver] = useState<LiveDriver>('human');
  const resuming = useMutation({
    mutationFn: resumeLive,
    onSuccess: async (live) => {
      await client.invalidateQueries({ queryKey: ['live'] });
      await navigate(`/live?open=${live.id}`);
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
  const built = variants.data.filter(isBuiltVariant);
  // 默认为 session 所用的 variant（它不在构建成功的列表中时为本机配置）
  const used = built.some((v) => v.id === defaults.data.variantId) ? defaults.data.variantId : null;
  const chosen = variant ?? used ?? LOCAL;
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
              {v.name}（{v.model} · {v.effort}）
            </option>
          ))}
          <option value={LOCAL}>本机配置（~/.claude）</option>
        </select>
      </label>
      <div className="flex flex-col gap-1 text-sm">
        <span className="font-medium">环境</span>
        <span>real：在下面的真实目录中运行，用本机的 GitHub 与 Linear 凭据，写入不加限制。</span>
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <span className="font-medium">工作目录</span>
        <span className="font-mono text-xs break-all" data-testid="resume-cwd">
          {defaults.data.cwd ?? '（session 没有记录工作目录）'}
        </span>
        {!defaults.data.cwdExists && (
          <span role="alert" className="text-destructive">
            这个目录不存在，不能 resume。
          </span>
        )}
      </div>
      <DriverChoice value={driver} onChange={setDriver} name={`resume-driver-${sessionId}`} />
      {resuming.isError && (
        <p role="alert" className="text-sm text-destructive">
          {resuming.error.message}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          取消
        </Button>
        <Button
          disabled={!defaults.data.cwdExists || resuming.isPending}
          onClick={() => {
            resuming.mutate({
              sessionId,
              variantId: chosen === LOCAL ? null : chosen,
              driver,
            });
          }}
        >
          <RotateCcw />
          {resuming.isPending ? '正在启动…' : 'resume'}
        </Button>
      </div>
    </div>
  );
}

// Sessions 详情与交互区的"resume"按钮（Contracts 14.5）
export function ResumeButton({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        data-testid="resume-open"
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
