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
import { variantsQuery } from '@/pages/variants-api';
import { ConfigSelect, LOCAL_CONFIG as LOCAL } from '@/components/live/config-select';
import { GoalField } from '@/components/live/simulated-goal';
import { sshHostsQuery } from '@/lib/ssh-api';

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
      <legend className="mb-1 text-sm font-medium">Initial driver</legend>
      {(
        [
          ['human', 'Human'],
          ['simulated', 'Simulated user'],
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

// Summary of one jsonl: path, time and content of the last message
function CopySummary({ label, copy }: { label: string; copy: ResumeCopy }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border px-3 py-2 text-xs">
      <span className="font-medium">{label}</span>
      <span className="font-mono break-all text-muted-foreground">{copy.path}</span>
      <span>
        Last message
        {copy.lastRole === 'user' ? ' (yours)' : copy.lastRole === 'assistant' ? ' (agent)' : ''}
        {copy.lastAt === null ? '' : `, ${formatDateTime(copy.lastAt)}`}:{' '}
        {copy.lastText ?? '(no messages)'}
      </span>
    </div>
  );
}

// Preflight result (Contracts 14.5): as soon as the dialog opens or the config changes, explains what
// resume will do, or why it can't resume
function PlanNotice({ plan }: { plan: ResumePlan }) {
  const box = 'flex flex-col gap-2 rounded-md border px-3 py-2 text-sm';
  if (plan.action === 'blocked') {
    return (
      <div className={`${box} border-destructive`} data-testid="resume-plan" data-action="blocked">
        <span className="font-medium text-destructive">Can't resume</span>
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
    if (plan.latest === null || plan.target === null)
      throw new Error('Diverged preflight is missing the two summaries');
    return (
      <div
        className={`${box} border-warning-border`}
        data-testid="resume-plan"
        data-action="diverged"
      >
        <span className="font-medium">The copy in this config differs from the latest</span>
        <span className="text-xs">
          Both copies were continued separately from some point. "Continue from latest" keeps the
          copy in this config under a new name (.diverged-&lt;time&gt;), then continues from the
          latest one.
        </span>
        <CopySummary label="Latest copy" copy={plan.latest} />
        <CopySummary label="Copy in this config" copy={plan.target} />
        {notes}
      </div>
    );
  }
  const text = {
    resume: 'Continues directly in this config.',
    copy: 'Copies the session into this config first, then continues; the original file is untouched.',
    sync: 'This config has an older copy: it is overwritten with the latest content first, then continues.',
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
  // In Sessions detail: after resume, open the workspace with this item selected
  navigateAfter: boolean;
}) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const defaults = useQuery(resumeDefaultsQuery(sessionId));
  const variants = useQuery(variantsQuery);
  const hosts = useQuery(sshHostsQuery);
  const [variant, setVariant] = useState<string | null>(null);
  const [driver, setDriver] = useState<LiveDriver>('human');
  // This time's goal when handing to the simulated user (Contracts 34.2)
  const [goal, setGoal] = useState('');
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const built = variants.data?.filter(isBuiltVariant) ?? [];
  // A Codex session resumes in its own CODEX_HOME; no variant to choose (Contracts 25.2)
  const codex = defaults.data?.engine === 'codex';
  // Defaults to the session's variant (local config when it is not among the built variants)
  const used = built.some((v) => v.id === defaults.data?.variantId)
    ? (defaults.data?.variantId ?? null)
    : null;
  const chosen = codex ? LOCAL : (variant ?? used ?? LOCAL);
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
      <p className="text-sm text-muted-foreground">Loading…</p>
    ) : (
      <p role="alert" className="text-sm text-destructive">
        {error.message}
      </p>
    );
  }
  // model and effort when a variant is chosen: the preflight defaults (the agentModel and agentEffort
  // settings) until changed
  const chosenModel: ModelEffort | null =
    plan.data?.model == null || plan.data.effort === null
      ? null
      : {
          model: (model ?? plan.data.model) as ModelEffort['model'],
          effort: (effort ?? plan.data.effort) as ModelEffort['effort'],
        };
  const p = plan.data;
  // A session on an SSH host resumes only on its host (Contracts 31.3): the config is the remote
  // machine's config or a variant
  const hostId = defaults.data.hostId;
  const hostLabel =
    hostId === null ? null : (hosts.data?.hosts.find((h) => h.id === hostId)?.label ?? hostId);
  const submit = (onDiverged?: 'use-latest') => {
    resuming.mutate({
      sessionId,
      variantId,
      driver,
      ...(driver === 'simulated' && !defaults.data.hasTask ? { goal: goal.trim() } : {}),
      // Local config passes no --model or --effort
      ...(variantId === null || chosenModel === null ? {} : chosenModel),
      ...(onDiverged === undefined ? {} : { onDiverged }),
    });
  };
  return (
    <div className="flex flex-col gap-4">
      {codex ? (
        <div className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">Config</span>
          <span>
            {hostLabel === null
              ? "Codex: runs codex resume in this session's CODEX_HOME."
              : `Codex: runs codex resume on ${hostLabel} with the remote machine's ~/.codex.`}
          </span>
          <span className="font-mono text-xs break-all" data-testid="resume-codex-home">
            {p?.configDir ?? '…'}
          </span>
        </div>
      ) : (
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">Config</span>
          <ConfigSelect
            value={chosen}
            onChange={setVariant}
            variants={built}
            testId="resume-variant"
            localLabel={
              hostLabel === null ? 'Local config (~/.claude)' : `${hostLabel} config (~/.claude)`
            }
          />
        </label>
      )}
      <div className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Environment and working directory</span>
        <span>
          {hostLabel === null
            ? 'real: runs in the real directory below with your local GitHub and Linear credentials; writes are unrestricted.'
            : `Runs in the real directory on ${hostLabel} with the remote machine's own credentials; writes are unrestricted.`}
        </span>
        <span className="font-mono text-xs break-all" data-testid="resume-cwd">
          {hostLabel === null ? '' : `${hostLabel}:`}
          {defaults.data.cwd ?? '(the session recorded no working directory)'}
        </span>
      </div>
      <DriverChoice
        value={driver}
        onChange={(next) => {
          setDriver(next);
          // The goal is prefilled with the item's first request (Contracts 34.2)
          if (next === 'simulated' && goal.trim() === '') {
            setGoal(defaults.data.simulatedGoal ?? defaults.data.simulatedGoalDefault);
          }
        }}
        name={`resume-driver-${sessionId}`}
      />
      {driver === 'simulated' && !defaults.data.hasTask && (
        <GoalField id={`resume-goal-${sessionId}`} value={goal} onChange={setGoal} />
      )}
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
          <p className="text-sm text-muted-foreground">Checking…</p>
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
          Cancel
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
            {resuming.isPending ? 'Starting…' : 'Continue from latest'}
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
            {resuming.isPending ? 'Starting…' : 'Resume'}
          </Button>
        )}
      </div>
    </div>
  );
}

// The "resume" button in Sessions detail and the workspace (Contracts 14.5): disabled while the
// session's item has a running process. The workspace passes onResumed (selects the item's tab);
// without it, the workspace opens with the item selected
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
        title={running ? 'This session is running in the workspace' : undefined}
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
            aria-label="Resume this session"
            className="flex w-[32rem] max-w-[90vw] flex-col gap-4 rounded-lg border bg-background p-5 shadow-lg"
            data-testid="resume-dialog"
          >
            <h2 className="text-base font-semibold">Resume this session</h2>
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
