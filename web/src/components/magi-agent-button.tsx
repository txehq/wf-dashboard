import { useMutation, useQuery } from '@tanstack/react-query';
import { Popover } from 'radix-ui';
import { type ReactNode, useState } from 'react';
import { useNavigate } from 'react-router';
import { EngineChoice } from '@/components/engine-choice';
import { MagiRobot } from '@/components/magi-robot';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';
import { isBuiltVariant } from '@/lib/live-api';
import {
  type MagiChoice,
  type MagiSessionView,
  openMagi,
  readMagiChoice,
  saveMagiChoice,
  useMagi,
} from '@/lib/magi-api';
import { variantLabel, variantsQuery } from '@/pages/variants-api';

const engineName = { claude: 'Claude Code', codex: 'Codex' } as const;

// 时间在前：同一个引擎与配置下的会话标题多半相同，窄的下拉中先看到时间
const sessionLabel = (s: MagiSessionView) =>
  `${formatDateTime(new Date(s.updatedAt).toISOString())} · ${s.title}${s.running ? ' · 运行中' : ''}`;

// 左侧导航最上面一行右端的小机器人按钮（Contracts 23.6）：任何页面都能点，弹出框中选引擎、配置与会话后"打开"
export function MagiAgentButton() {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          className="magi-robot-host"
          aria-label="Magi Agent"
          title="Magi Agent"
          data-testid="magi-agent"
        >
          <MagiRobot className="size-6" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          side="bottom"
          sideOffset={6}
          className="z-[60] w-[22rem] rounded-lg border bg-background p-4 shadow-lg"
          data-testid="magi-popover"
        >
          {/* 每次打开弹出框时重新读取上次的选择 */}
          {open && (
            <MagiPopover
              onOpened={() => {
                setOpen(false);
              }}
            />
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function MagiPopover({ onOpened }: { onOpened: () => void }) {
  const navigate = useNavigate();
  const magi = useMagi();
  const variants = useQuery(variantsQuery);
  const [choice, setChoice] = useState<MagiChoice>(readMagiChoice);
  const built = (variants.data ?? []).filter(isBuiltVariant);
  // Codex 只有本机配置；上次选的 variant 已不能用（删除或要重新构建）时显示本机配置
  const config =
    choice.engine === 'claude' && built.some((v) => v.id === choice.config)
      ? choice.config
      : 'local';
  const sessions = (magi.data?.sessions ?? []).filter(
    (s) => s.engine === choice.engine && s.config === config,
  );
  // 继续：上次选的会话不在这个引擎与配置下时选最近的一个；没有会话时只有新会话
  const savedId = choice.session.kind === 'continue' ? choice.session.liveId : null;
  const continued =
    choice.session.kind === 'continue'
      ? (sessions.find((s) => s.id === savedId) ?? sessions[0])
      : undefined;
  const isNew = continued === undefined;
  const opening = useMutation({
    mutationFn: openMagi,
    onSuccess: async (live) => {
      // 记下的会话是这次打开的那一个（新会话时为新建的），下次默认继续它
      saveMagiChoice({ engine: choice.engine, config, liveId: live.id });
      onOpened();
      await navigate(`/live?item=${live.id}`);
    },
  });
  const submit = () => {
    opening.mutate({
      engine: choice.engine,
      config,
      liveId: isNew ? null : continued.id,
    });
  };
  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="magi-robot-host flex items-center gap-2">
        <MagiRobot className="size-7" label="Magi Agent" />
        <div className="flex min-w-0 flex-col">
          <span className="font-semibold">Magi Agent</span>
          <span className="text-xs text-muted-foreground">
            修改 dashboard、回答用法、讨论遇到的问题
          </span>
        </div>
      </div>
      <Field label="引擎">
        <EngineChoice
          value={choice.engine}
          onChange={(engine) => {
            setChoice({ ...choice, engine });
          }}
        />
      </Field>
      <Field label="配置">
        <select
          className="h-8 rounded-md border bg-background px-2 disabled:opacity-70"
          aria-label="配置"
          data-testid="magi-config-select"
          value={config}
          disabled={choice.engine === 'codex'}
          onChange={(event) => {
            setChoice({ ...choice, config: event.target.value });
          }}
        >
          <option value="local">本机配置</option>
          {choice.engine === 'claude' &&
            built.map((v) => (
              <option key={v.id} value={v.id}>
                {variantLabel(v)}
              </option>
            ))}
        </select>
        {choice.engine === 'codex' && (
          <span className="text-xs text-muted-foreground">Codex 只有本机配置（~/.codex）。</span>
        )}
      </Field>
      <Field label="会话">
        <div className="flex flex-col gap-2" role="radiogroup" aria-label="会话">
          {sessions.length > 0 && (
            <label className="flex min-w-0 items-center gap-2">
              <input
                type="radio"
                name="magi-session"
                data-testid="magi-session-continue"
                checked={!isNew}
                onChange={() => {
                  setChoice({ ...choice, session: { kind: 'continue', liveId: null } });
                }}
              />
              继续
              <select
                className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2"
                aria-label="继续的会话"
                data-testid="magi-session-select"
                value={continued?.id ?? sessions[0]?.id}
                disabled={isNew}
                onChange={(event) => {
                  setChoice({
                    ...choice,
                    session: { kind: 'continue', liveId: event.target.value },
                  });
                }}
              >
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {sessionLabel(s)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="magi-session"
              data-testid="magi-session-new"
              checked={isNew}
              onChange={() => {
                setChoice({ ...choice, session: { kind: 'new' } });
              }}
            />
            新会话
          </label>
        </div>
      </Field>
      {opening.isError && (
        <p role="alert" className="text-xs whitespace-pre-wrap text-destructive">
          {opening.error.message}
        </p>
      )}
      <div className="flex items-center gap-3 border-t pt-3">
        <span className="min-w-0 flex-1 text-xs text-muted-foreground" data-testid="magi-summary">
          {isNew
            ? `新建一个 ${engineName[choice.engine]} 的会话`
            : continued.running
              ? '打开运行中的会话'
              : '打开并 resume 这个会话'}
        </span>
        <Button
          size="sm"
          data-testid="magi-open"
          disabled={opening.isPending || magi.data === undefined}
          onClick={submit}
        >
          打开
        </Button>
      </div>
    </div>
  );
}
