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

// Time first: session titles under the same engine and config are mostly the same, so the narrow
// select shows the time first
const sessionLabel = (s: MagiSessionView) =>
  `${formatDateTime(new Date(s.updatedAt).toISOString())} · ${s.title}${s.running ? ' · Running' : ''}`;

// The small robot button at the right end of the top row of the left nav (Contracts 23.6): clickable
// on every page; the popover picks engine, config and session, then "Open"
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
          {/* Re-read the last choice each time the popover opens */}
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
  // Codex has only local config; when the last chosen variant is no longer usable (deleted or needs a
  // rebuild), local config is shown
  const config =
    choice.engine === 'claude' && built.some((v) => v.id === choice.config)
      ? choice.config
      : 'local';
  const sessions = (magi.data?.sessions ?? []).filter(
    (s) => s.engine === choice.engine && s.config === config,
  );
  // Continue: when the last chosen session is not under this engine and config, pick the most recent
  // one; with no sessions there is only a new session
  const savedId = choice.session.kind === 'continue' ? choice.session.liveId : null;
  const continued =
    choice.session.kind === 'continue'
      ? (sessions.find((s) => s.id === savedId) ?? sessions[0])
      : undefined;
  const isNew = continued === undefined;
  const opening = useMutation({
    mutationFn: openMagi,
    onSuccess: async (live) => {
      // Remember the session opened this time (the created one for a new session) and continue it next time
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
            Change the dashboard, answer how-to questions, talk through problems
          </span>
        </div>
      </div>
      <Field label="Engine">
        <EngineChoice
          value={choice.engine}
          onChange={(engine) => {
            setChoice({ ...choice, engine });
          }}
        />
      </Field>
      <Field label="Config">
        <select
          className="h-8 rounded-md border bg-background px-2 disabled:opacity-70"
          aria-label="Config"
          data-testid="magi-config-select"
          value={config}
          disabled={choice.engine === 'codex'}
          onChange={(event) => {
            setChoice({ ...choice, config: event.target.value });
          }}
        >
          <option value="local">Local config</option>
          {choice.engine === 'claude' &&
            built.map((v) => (
              <option key={v.id} value={v.id}>
                {variantLabel(v)}
              </option>
            ))}
        </select>
        {choice.engine === 'codex' && (
          <span className="text-xs text-muted-foreground">
            Codex has only local config (~/.codex).
          </span>
        )}
      </Field>
      <Field label="Session">
        <div className="flex flex-col gap-2" role="radiogroup" aria-label="Session">
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
              Continue
              <select
                className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2"
                aria-label="Session to continue"
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
            New session
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
            ? `Start a new ${engineName[choice.engine]} session`
            : continued.running
              ? 'Open the running session'
              : 'Open and resume this session'}
        </span>
        <Button
          size="sm"
          data-testid="magi-open"
          disabled={opening.isPending || magi.data === undefined}
          onClick={submit}
        >
          Open
        </Button>
      </div>
    </div>
  );
}
