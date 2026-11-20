import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { InlineRename } from '@/components/inline-rename';
import { PageShell } from '@/components/page-shell';
import { AddHostForm, HostCheckList } from '@/components/ssh/ssh-parts';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';
import { saveSettings, settingsQuery } from '@/lib/runs-api';
import {
  deleteHost,
  hostProblems,
  recheckHost,
  renameHost,
  type SshHostView,
  sshHostsQuery,
  useSshHostEvents,
} from '@/lib/ssh-api';

// One host: name (editable), target, time and item results of the latest check; Recheck and Delete sit on the name's row
function HostRow({ host }: { host: SshHostView }) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ['ssh-hosts'] });
  const recheck = useMutation({ mutationFn: () => recheckHost(host.id), onSuccess: refresh });
  const remove = useMutation({ mutationFn: () => deleteHost(host.id), onSuccess: refresh });
  const problems = host.check === null ? [] : hostProblems(host.check, null);
  return (
    <li
      className="flex flex-col gap-2 border-b py-3 last:border-b-0"
      data-testid={`ssh-host-${host.id}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <InlineRename
          value={host.label}
          label="Host name"
          testId="host-label"
          className="text-sm font-medium"
          onSave={(next) => renameHost(host.id, next).then(refresh)}
        />
        <span className="font-mono text-xs text-muted-foreground">{host.target}</span>
        <span className="text-xs text-muted-foreground">
          {host.checkedAt === null
            ? 'Not checked yet'
            : `Checked ${formatDateTime(new Date(host.checkedAt).toISOString())}`}
          {problems.length > 0 ? ` · Can't start: ${problems.join('; ')}` : ''}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={recheck.isPending}
            data-testid="recheck-host"
            onClick={() => {
              recheck.mutate();
            }}
          >
            <RefreshCw />
            {recheck.isPending ? 'Checking…' : 'Recheck'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={host.running || remove.isPending}
            title={
              host.running
                ? 'Interactions are running on this host; stop their processes first'
                : 'Delete this host'
            }
            data-testid="delete-host"
            onClick={() => {
              remove.mutate();
            }}
          >
            <Trash2 />
            Delete
          </Button>
        </span>
      </div>
      {host.check !== null && <HostCheckList check={host.check} />}
      {(recheck.isError || remove.isError) && (
        <p role="alert" className="text-xs whitespace-pre-wrap text-destructive">
          {(recheck.error ?? remove.error)?.message}
        </p>
      )}
    </li>
  );
}

// The SSH hosts section (Contracts 31.1): Live interactions can run on these hosts
function SshHostsSection() {
  const hosts = useQuery(sshHostsQuery);
  const [adding, setAdding] = useState(false);
  return (
    <section className="flex flex-col gap-3 rounded-lg border p-4" data-testid="settings-ssh-hosts">
      <div className="flex items-center gap-3">
        <h2 className="text-base font-semibold">SSH hosts</h2>
        <p className="text-sm text-muted-foreground">
          Live interactions can run on these hosts, connecting with this machine's ssh and keys.
        </p>
        <Button
          size="sm"
          className="ml-auto"
          variant={adding ? 'secondary' : 'default'}
          data-testid="show-add-host"
          onClick={() => {
            setAdding(!adding);
          }}
        >
          <Plus />
          Add host
        </Button>
      </div>
      {adding && (
        <AddHostForm
          autoFocus
          configHosts={hosts.data?.configHosts ?? []}
          onAdded={() => {
            setAdding(false);
          }}
        />
      )}
      {hosts.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {hosts.isError && (
        <p role="alert" className="text-sm text-destructive">
          {hosts.error.message}
        </p>
      )}
      {hosts.data !== undefined &&
        (hosts.data.hosts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No hosts added yet.</p>
        ) : (
          <ul aria-label="SSH hosts">
            {hosts.data.hosts.map((h) => (
              <HostRow key={h.id} host={h} />
            ))}
          </ul>
        ))}
    </section>
  );
}

// Linear stats (Contracts 37.1): the timezone whose midnight ends a day; the page recounts at once on save
function TeamStatsSection() {
  const client = useQueryClient();
  const settings = useQuery(settingsQuery);
  const [draft, setDraft] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (zone: string) => {
      if (settings.data === undefined) throw new Error('Settings are not loaded');
      return saveSettings({ ...settings.data, teamStatsTimezone: zone });
    },
    onSuccess: (saved) => {
      client.setQueryData(settingsQuery.queryKey, saved);
      setDraft(null);
      void client.invalidateQueries({ queryKey: ['team'] });
    },
  });
  const current = settings.data?.teamStatsTimezone;
  const value = draft ?? current ?? '';
  return (
    <section
      className="flex flex-col gap-3 rounded-lg border p-4"
      data-testid="settings-team-stats"
    >
      <h2 className="text-base font-semibold">Engineering stats</h2>
      {settings.isError && <p className="text-sm text-destructive">{settings.error.message}</p>}
      <form
        className="flex flex-wrap items-center gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(value);
        }}
      >
        <label className="flex items-center gap-2 text-sm">
          Day boundary timezone
          <select
            className="h-8 rounded-md border bg-background px-2 text-sm"
            value={value}
            disabled={current === undefined}
            data-testid="team-timezone"
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          >
            {timeZones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="submit"
          size="sm"
          disabled={draft === null || draft === current || save.isPending}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        <span className="text-xs text-muted-foreground">
          Days on the Engineering stats page end at midnight here.
        </span>
      </form>
      {save.isError && (
        <p role="alert" className="text-sm text-destructive">
          Could not save: {save.error.message}
        </p>
      )}
    </section>
  );
}

const timeZones = Intl.supportedValuesOf('timeZone');

// Global settings (opened from the gear at the right end of the top bar), in sections
export function SettingsPage() {
  useSshHostEvents();
  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <PageShell title="Settings" description="Settings for the dashboard itself, in sections." />
      <SshHostsSection />
      <TeamStatsSection />
    </div>
  );
}
