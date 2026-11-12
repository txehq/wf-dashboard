import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { useState } from 'react';
import { ConfigSelect, LOCAL_CONFIG } from '@/components/live/config-select';
import { DriverChoice } from '@/components/live/resume-dialog';
import { GoalField } from '@/components/live/simulated-goal';
import { ModelEffortChoice } from '@/components/model-effort';
import { AddHostForm, HostCheckList } from '@/components/ssh/ssh-parts';
import { DirBrowser } from '@/components/dir-browser';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  createLive,
  isBuiltVariant,
  type LiveDetail,
  type LiveDriver,
  localEntriesQuery,
} from '@/lib/live-api';
import { useModelEffort } from '@/lib/model-effort';
import {
  addHost,
  hostCheckQuery,
  hostProblems,
  sshHostsQuery,
  useSshHostEvents,
} from '@/lib/ssh-api';
import { defaultLiveVariant, workflowsQuery } from '@/lib/workflows-api';
import { variantsQuery } from '@/pages/variants-api';

type Environment = 'isolated' | 'real';
type Engine = 'claude' | 'codex';

// Value of "No command" in the initial command select
const NO_COMMAND = '';
// Location select (Contracts 31.3): this machine, added hosts (id), Hosts in ~/.ssh/config
// (config:<name>), add a new host
const LOCAL = 'local';
const ADD_HOST = 'add-host';
const CONFIG_HOST = 'config:';

const engineName = { claude: 'Claude Code', codex: 'Codex' } as const;

// What the isolated environment prepares by the eval kind of the command's workflow (Contracts 14.2, 29.2)
function isolatedNote(command: string | null, evalKind: 'lfg' | 'ic' | null): string {
  if (command === null) return 'Creates an empty workspace only.';
  if (evalKind === 'lfg') {
    return 'Creates an empty copy repo in txehq and writes to Project Magi Eval in the vault; the input is the idea.';
  }
  if (evalKind === 'ic') {
    return 'The input must be a Linear ticket URL or ID: reads the starting repo and commit from the ticket, copies the repo into txehq and the ticket into Workflow Eval.';
  }
  return 'No eval kind: creates an empty workspace only.';
}

const warning =
  'rounded-md border border-warning-border bg-warning px-3 py-2 text-xs text-warning-foreground';

// New interaction (Contracts 29.2, 31.3): location -> config -> initial command -> input ->
// environment, driver, model and effort. With a variant, its workflow's entry command is the default;
// with local (or remote machine) config, no command by default and the input goes to the agent as is.
// On an SSH host: the engine is Claude Code or Codex as available remotely, the working directory is an
// existing remote directory, and the environment is always the remote real directory
export function NewLiveForm({ onCreated }: { onCreated: (live: LiveDetail) => void }) {
  useSshHostEvents();
  const client = useQueryClient();
  const workflows = useQuery(workflowsQuery);
  const variants = useQuery(variantsQuery);
  const localEntries = useQuery(localEntriesQuery);
  const hosts = useQuery(sshHostsQuery);
  const [location, setLocation] = useState(LOCAL);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [config, setConfig] = useState<string | null>(null);
  // undefined: not changed yet, use this config's default
  const [command, setCommand] = useState<string | null | undefined>(undefined);
  const [input, setInput] = useState('');
  const [environment, setEnvironment] = useState<Environment>('isolated');
  const [cwd, setCwd] = useState('');
  const [driver, setDriver] = useState<LiveDriver>('human');
  // When the initial driver is the simulated user, what it should do this time (Contracts 34.2): prefilled with the input
  const [goal, setGoal] = useState('');
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  // Default model and effort come from settings; can't start until they are loaded
  const chosenModel = useModelEffort({ model, effort });
  const creating = useMutation({
    mutationFn: createLive,
    onSuccess: async (live) => {
      setInput('');
      await client.invalidateQueries({ queryKey: ['live'] });
      onCreated(live);
    },
  });
  // Picking a Host straight from ~/.ssh/config: add it first (saved once the check passes), then select it
  const addingConfigHost = useMutation({
    mutationFn: addHost,
    onSuccess: async (host) => {
      await client.invalidateQueries({ queryKey: ['ssh-hosts'] });
      setLocation(host.id);
    },
  });

  const host = hosts.data?.hosts.find((h) => h.id === location) ?? null;
  const remote = host !== null;
  const check = useQuery({ ...hostCheckQuery(location), enabled: remote });
  const hostCheck = remote ? (check.data?.check ?? null) : null;
  const engines: Engine[] = remote ? (hostCheck?.engines ?? []) : ['claude'];
  const chosenEngine: Engine | null =
    engine !== null && engines.includes(engine) ? engine : (engines[0] ?? null);
  const codex = chosenEngine === 'codex';

  const built = (variants.data ?? []).filter(isBuiltVariant);
  // Default config: the variant of the latest lfg release (Contracts 29.1), then any lfg or built
  // variant, otherwise local config; on an SSH host the remote machine's config, and Codex has only that
  const defaultConfig = remote
    ? LOCAL_CONFIG
    : (defaultLiveVariant(workflows.data, built)?.id ?? LOCAL_CONFIG);
  const chosenConfig = codex
    ? LOCAL_CONFIG
    : config !== null && (config === LOCAL_CONFIG || built.some((v) => v.id === config))
      ? config
      : defaultConfig;
  const variant = built.find((v) => v.id === chosenConfig) ?? null;
  const ownEntries = remote ? (hostCheck?.entries ?? []) : (localEntries.data?.workflows ?? []);
  const commands = codex ? [] : variant === null ? ownEntries : [variant.workflowId];
  const chosenCommand = codex
    ? null
    : command === undefined
      ? (variant?.workflowId ?? null)
      : command;
  const commandWorkflow =
    chosenCommand === null ? undefined : workflows.data?.find((w) => w.id === chosenCommand);
  const isIc = commandWorkflow?.evalKind === 'ic';
  const problems = hostCheck === null ? [] : hostProblems(hostCheck, chosenEngine);
  const chosenEnvironment: Environment = remote ? 'real' : environment;
  const ready =
    variants.data !== undefined &&
    location !== ADD_HOST &&
    (!remote || (hostCheck !== null && problems.length === 0 && chosenEngine !== null)) &&
    (variant === null || chosenModel !== null) &&
    (chosenCommand === null || commandWorkflow !== undefined) &&
    input.trim() !== '' &&
    (driver === 'human' || goal.trim() !== '') &&
    (chosenEnvironment === 'isolated' || cwd.trim() !== '');

  const chooseLocation = (value: string) => {
    if (value.startsWith(CONFIG_HOST)) {
      addingConfigHost.mutate(value.slice(CONFIG_HOST.length));
      return;
    }
    addingConfigHost.reset();
    setLocation(value);
    setConfig(null);
    setCommand(undefined);
    setEngine(null);
    setCwd('');
  };

  return (
    <Card data-testid="new-live">
      <CardHeader>
        <CardTitle>New interaction</CardTitle>
        <CardDescription>
          Work in a real Claude Code or Codex terminal; not graded and not included in comparisons.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid gap-5 lg:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Location</span>
            <select
              className="h-9 rounded-md border bg-background px-2"
              data-testid="live-location"
              value={location}
              disabled={addingConfigHost.isPending}
              onChange={(event) => {
                chooseLocation(event.target.value);
              }}
            >
              <option value={LOCAL}>This machine</option>
              {(hosts.data?.hosts ?? []).map((h) => (
                <option key={h.id} value={h.id}>
                  {h.label}
                </option>
              ))}
              {(hosts.data?.configHosts.length ?? 0) > 0 && (
                <optgroup label="Hosts in ~/.ssh/config">
                  {hosts.data?.configHosts.map((name) => (
                    <option key={name} value={`${CONFIG_HOST}${name}`}>
                      {name}
                    </option>
                  ))}
                </optgroup>
              )}
              <option value={ADD_HOST}>Add SSH host…</option>
            </select>
            {addingConfigHost.isPending && (
              <span className="text-xs text-muted-foreground">Connecting and checking…</span>
            )}
            {addingConfigHost.isError && (
              <span role="alert" className="font-mono text-xs whitespace-pre-wrap text-destructive">
                {addingConfigHost.error.message}
              </span>
            )}
          </label>
          {remote && (
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Engine</span>
              <select
                className="h-9 rounded-md border bg-background px-2"
                data-testid="live-engine-select"
                value={chosenEngine ?? ''}
                disabled={engines.length === 0}
                onChange={(event) => {
                  setEngine(event.target.value as Engine);
                  setCommand(undefined);
                }}
              >
                {engines.length === 0 && (
                  <option value="">No Claude Code or Codex on the remote</option>
                )}
                {engines.map((e) => (
                  <option key={e} value={e}>
                    {engineName[e]}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {location === ADD_HOST && (
          <AddHostForm
            autoFocus
            configHosts={hosts.data?.configHosts ?? []}
            onAdded={(added) => {
              chooseLocation(added.id);
            }}
          />
        )}

        {remote && (
          <div className="flex flex-col gap-2 rounded-md border p-3" data-testid="live-host-check">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium">Checks for {host.label}</span>
              <span className="font-mono text-xs text-muted-foreground">{host.target}</span>
              {check.isFetching && <span className="text-xs text-muted-foreground">Checking…</span>}
            </div>
            {check.isError && (
              <p role="alert" className="font-mono text-xs whitespace-pre-wrap text-destructive">
                {check.error.message}
              </p>
            )}
            {hostCheck !== null && <HostCheckList check={hostCheck} />}
            {problems.length > 0 && (
              <p role="alert" className="text-sm text-destructive" data-testid="live-host-problems">
                Can't start on {host.label}: {problems.join('; ')}
              </p>
            )}
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Config</span>
            {variants.isError && <span className="text-destructive">{variants.error.message}</span>}
            {codex ? (
              <select className="h-9 rounded-md border bg-background px-2" disabled value="">
                <option value="">{host?.label} config (~/.codex)</option>
              </select>
            ) : (
              <ConfigSelect
                value={chosenConfig}
                onChange={(value) => {
                  setConfig(value);
                  setCommand(undefined);
                }}
                variants={built}
                testId="live-config"
                localLabel={
                  remote ? `${host.label} config (~/.claude)` : 'Local config (~/.claude)'
                }
              />
            )}
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Initial command</span>
            {!remote && localEntries.isError && (
              <span role="alert" className="text-destructive">
                Couldn't load local entry skills: {localEntries.error.message}
              </span>
            )}
            <select
              className="h-9 rounded-md border bg-background px-2"
              data-testid="live-command"
              value={chosenCommand ?? NO_COMMAND}
              disabled={codex}
              onChange={(event) => {
                setCommand(event.target.value === NO_COMMAND ? null : event.target.value);
              }}
            >
              <option value={NO_COMMAND}>No command</option>
              {commands.map((id) => (
                <option key={id} value={id}>
                  /{id} ({workflows.data?.find((w) => w.id === id)?.name ?? id})
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">Input</span>
          <Textarea
            aria-label="Input"
            placeholder={
              chosenCommand === null
                ? 'Message to send to the agent'
                : isIc
                  ? 'https://linear.app/capso/issue/TXE-3777/… or TXE-3777'
                  : 'build a calculator'
            }
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
            }}
          />
          {chosenCommand === null ? (
            <span className="text-xs text-muted-foreground" data-testid="live-initial-note">
              No command: the input goes to the agent as is.
            </span>
          ) : (
            <span
              className="font-mono text-xs whitespace-pre-wrap text-muted-foreground"
              data-testid="live-initial"
            >
              /{chosenCommand} {input.trim()}
            </span>
          )}
        </label>

        <div className="grid gap-5 lg:grid-cols-2">
          {remote ? (
            <div className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Working directory (on {host.label})</span>
              <div className="flex items-center gap-2">
                <Input
                  aria-label="Working directory"
                  className="font-mono"
                  placeholder={`${hostCheck?.home ?? '/home/you'}/project`}
                  value={cwd}
                  onChange={(event) => {
                    setCwd(event.target.value);
                  }}
                />
                <DirBrowser
                  source={{ kind: 'ssh', hostId: host.id }}
                  title={`Choose a working directory on ${host.label}`}
                  start={cwd.trim()}
                  onPick={(dir) => {
                    setCwd(dir);
                  }}
                />
              </div>
              <p role="note" className={warning} data-testid="real-warning">
                Writes to the real directory on {host.label} with the remote machine's own
                credentials; writes are unrestricted and there is no sandbox.
              </p>
            </div>
          ) : (
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 text-sm font-medium">Environment</legend>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="live-environment"
                  checked={environment === 'isolated'}
                  onChange={() => {
                    setEnvironment('isolated');
                  }}
                />
                <span>
                  isolated: the process runs in a sandbox
                  {variant === null ? ' and can read and write ~/.claude' : ''}.
                  <span className="text-muted-foreground" data-testid="live-isolated-note">
                    {' '}
                    {isolatedNote(chosenCommand, commandWorkflow?.evalKind ?? null)}
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="live-environment"
                  checked={environment === 'real'}
                  onChange={() => {
                    setEnvironment('real');
                  }}
                />
                <span>real: runs in a real directory you choose</span>
              </label>
              {environment === 'real' && (
                <>
                  <div className="flex items-center gap-2">
                    <Input
                      aria-label="Working directory"
                      className="font-mono"
                      placeholder="/Users/you/Project/…"
                      value={cwd}
                      onChange={(event) => {
                        setCwd(event.target.value);
                      }}
                    />
                    <DirBrowser
                      source={{ kind: 'local' }}
                      title="Choose a local working directory"
                      start={cwd.trim()}
                      onPick={(dir) => {
                        setCwd(dir);
                      }}
                    />
                  </div>
                  <p role="note" className={warning} data-testid="real-warning">
                    Writes to real directories, repos and tickets with your local GitHub and Linear
                    credentials; writes are unrestricted and there is no sandbox.
                  </p>
                </>
              )}
            </fieldset>
          )}
          <div className="flex flex-col gap-4">
            <DriverChoice
              value={driver}
              onChange={(next) => {
                setDriver(next);
                // The goal is prefilled with the input (Contracts 34.2)
                if (next === 'simulated' && goal.trim() === '') setGoal(input.trim());
              }}
              name="live-driver"
            />
            {/* Simulated user chosen: write what it should do this time in the form (Contracts 34.2) */}
            {driver === 'simulated' && <GoalField id="live-goal" value={goal} onChange={setGoal} />}
            {/* Local (or remote machine) config passes no --model or --effort and uses its own settings */}
            {variant !== null && !codex && (
              <ModelEffortChoice
                value={chosenModel}
                onModel={setModel}
                onEffort={setEffort}
                testIdPrefix="live"
              />
            )}
          </div>
        </div>

        {creating.isError && (
          <p role="alert" className="text-sm whitespace-pre-wrap text-destructive">
            {creating.error.message}
          </p>
        )}
        <div className="flex items-center gap-3">
          <Button
            disabled={!ready || creating.isPending}
            data-testid="live-start"
            onClick={() => {
              creating.mutate({
                workflow: chosenCommand,
                input: input.trim(),
                variantId: variant?.id ?? null,
                environment: chosenEnvironment,
                cwd: chosenEnvironment === 'real' ? cwd.trim() : null,
                driver,
                ...(goal.trim() === '' ? {} : { goal: goal.trim() }),
                hostId: host?.id ?? null,
                engine: chosenEngine ?? 'claude',
                ...(variant === null || chosenModel === null ? {} : chosenModel),
              });
            }}
          >
            <Play />
            {creating.isPending
              ? chosenEnvironment === 'isolated' && (commandWorkflow?.evalKind ?? null) !== null
                ? 'Creating copy repo…'
                : remote
                  ? `Starting on ${host.label}…`
                  : 'Starting…'
              : remote
                ? `Start on ${host.label}`
                : 'Start'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
