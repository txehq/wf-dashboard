import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { efforts, modelAliases } from '@wf-dashboard/server/variants/model-names';
import { Settings2 } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import { ModelEffortChoice } from '@/components/model-effort';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { saveSettings, type Settings, settingsQuery } from '@/lib/runs-api';

const numberFields = [
  { key: 'runConcurrency', label: 'Concurrent runs', min: 1, max: 32 },
  { key: 'maxUserTurns', label: 'Max simulated user answers', min: 1, max: 1000 },
  { key: 'defaultRepeats', label: 'Default repeats', min: 1, max: 50 },
] as const;

const modelFields = [
  { key: 'simulatedUser', label: 'Simulated user model' },
  { key: 'judge', label: 'Judge model' },
] as const;

// One label per line; blank lines are ignored
const parseLabels = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');

function SettingsForm({ initial }: { initial: Settings }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<Settings>(initial);
  const [labelsText, setLabelsText] = useState(initial.copyRunnerLabels.join('\n'));
  const save = useMutation({
    mutationFn: saveSettings,
    onSuccess: (saved) => {
      client.setQueryData(settingsQuery.queryKey, saved);
      setDraft(saved);
      setLabelsText(saved.copyRunnerLabels.join('\n'));
    },
  });
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  return (
    <form
      className="flex flex-col gap-4"
      data-testid="settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(draft);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        {numberFields.map((f) => (
          <label key={f.key} className="flex flex-col gap-1 text-sm">
            {f.label}
            <Input
              type="number"
              min={f.min}
              max={f.max}
              required
              value={draft[f.key]}
              onChange={(event) => {
                setDraft({ ...draft, [f.key]: Number(event.target.value) });
              }}
            />
          </label>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {modelFields.map((f) => (
          <label key={f.key} className="flex flex-col gap-1 text-sm">
            {f.label}
            <Input
              required
              className="font-mono"
              value={draft.models[f.key]}
              onChange={(event) => {
                setDraft({ ...draft, models: { ...draft.models, [f.key]: event.target.value } });
              }}
            />
          </label>
        ))}
      </div>
      <div className="flex flex-col gap-1 text-sm" data-testid="settings-agent">
        <span>
          Default agent model and effort (used when none is chosen for a batch, a new interaction or
          a resume)
        </span>
        <ModelEffortChoice
          value={{ model: draft.agentModel, effort: draft.agentEffort }}
          onModel={(model) => {
            setDraft({ ...draft, agentModel: z.enum(modelAliases).parse(model) });
          }}
          onEffort={(effort) => {
            setDraft({ ...draft, agentEffort: z.enum(efforts).parse(effort) });
          }}
          testIdPrefix="settings"
        />
      </div>
      <label className="flex flex-col gap-1 text-sm">
        Self-hosted runner labels for copy repos (one per line)
        <Textarea
          aria-label="Self-hosted runner labels for copy repos"
          className="min-h-16 font-mono field-sizing-fixed"
          rows={3}
          value={labelsText}
          onChange={(event) => {
            setLabelsText(event.target.value);
            setDraft({ ...draft, copyRunnerLabels: parseLabels(event.target.value) });
          }}
        />
        <span className="text-xs text-muted-foreground">
          A job counts toward an imported task's default required checks when every runs-on label is
          a GitHub-hosted runner, self-hosted, or listed here.
        </span>
      </label>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={!dirty || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save settings'}
        </Button>
        <span className="text-xs text-muted-foreground">
          Takes effect on save. Lowering concurrent runs does not interrupt runs in progress.
        </span>
      </div>
      {save.isError && (
        <p role="alert" className="text-sm text-destructive">
          Could not save: {save.error.message}
        </p>
      )}
    </form>
  );
}

export function RunSettings() {
  const settings = useQuery(settingsQuery);
  return (
    <details className="rounded-lg border px-4 py-3" data-testid="run-settings">
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium">
        <Settings2 className="size-4" aria-hidden />
        Settings
        {settings.data !== undefined && (
          <span className="font-normal text-muted-foreground">
            {settings.data.runConcurrency} concurrent · agent {settings.data.agentModel}/
            {settings.data.agentEffort} · simulated user {settings.data.models.simulatedUser} ·
            judge {settings.data.models.judge}
          </span>
        )}
      </summary>
      <div className="pt-4">
        {settings.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
        {settings.isError && <p className="text-sm text-destructive">{settings.error.message}</p>}
        {settings.data !== undefined && (
          <SettingsForm key={JSON.stringify(settings.data)} initial={settings.data} />
        )}
      </div>
    </details>
  );
}
