import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, ExternalLink, GitBranch, SquareTerminal } from 'lucide-react';
import { useNavigate } from 'react-router';
import { EngineLogo } from '@/components/live/live-identity';
import { VscodeLogo } from '@/components/live/open-in-vscode';
import { StateBadge } from '@/components/live/orca-topology';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDateTime, formatUsd } from '@/lib/format';
import {
  type OrcaGraph,
  type OrcaGraphNode,
  openOrcaNodeInLive,
  orcaMessagesQuery,
  switchOrcaTerminal,
} from '@/lib/orca-api';
import { engineOf } from '@/lib/orca-states';
import type { ShownEdge } from '@/lib/orca-view';
import { openVscodeForOrcaNode } from '@/lib/vscode-api';

// The right drawer of the topology page (Contracts 40.2): one session with its three ways to open it, or every message
// between the two ends of an edge

const kindLabel: Record<OrcaGraphNode['kind'], string> = {
  coordinator: 'Main agent',
  worker: 'Worker',
  peer: 'Session outside the Runs',
};

const time = (at: number) => formatDateTime(new Date(at).toISOString());

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

// Each way to open a session, as the drawer lists them
const ways = [
  { key: 'live', label: 'Live' },
  { key: 'orca', label: 'Orca' },
  { key: 'vscode', label: 'VS Code' },
] as const;

export function NodeDetail({ node }: { node: OrcaGraphNode }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const openLive = useMutation({
    mutationFn: async () => {
      // A closed item is shown again, a session with no item yet is imported, before its tab opens
      const liveId = await openOrcaNodeInLive(node.id);
      await client.invalidateQueries({ queryKey: ['live'] });
      await navigate(`/live?item=${liveId}`);
    },
  });
  const openOrca = useMutation({
    mutationFn: (handle: string) => switchOrcaTerminal(handle, node.host?.id ?? null),
  });
  const openCode = useMutation({ mutationFn: () => openVscodeForOrcaNode(node.id) });
  const engine = engineOf(node.agent);
  const error = openLive.error ?? openOrca.error ?? openCode.error;
  const unavailable = ways.flatMap((w) => {
    const reason = node.open[w.key];
    return reason === null ? [] : [{ ...w, reason }];
  });
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="orca-node-detail" data-node={node.id}>
      <div className="flex min-w-0 flex-col gap-2">
        <h3 className="flex min-w-0 items-center gap-1.5 text-base font-semibold">
          {engine !== null && <EngineLogo engine={engine} className="size-4" />}
          <span className="min-w-0 break-words">{node.title}</span>
        </h3>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {node.state !== null && <StateBadge state={node.state} />}
          <span>{kindLabel[node.kind]}</span>
          {node.host !== null && <span>on {node.host.label ?? node.host.id}</span>}
          {node.openTerminal !== null && <span>Terminal open in Orca</span>}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={node.open.live !== null || openLive.isPending}
            title={node.open.live ?? 'Open in Live'}
            data-testid="orca-open-live"
            onClick={() => {
              openLive.mutate();
            }}
          >
            <SquareTerminal />
            Open in Live
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={node.open.orca !== null || openOrca.isPending}
            title={node.open.orca ?? 'Switch the Orca app to this terminal'}
            data-testid="orca-open-orca"
            onClick={() => {
              if (node.openTerminal !== null) openOrca.mutate(node.openTerminal);
            }}
          >
            <ExternalLink />
            Open in Orca
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={node.open.vscode !== null || openCode.isPending}
            title={node.open.vscode ?? 'Open in VS Code'}
            aria-label="Open in VS Code"
            data-testid="orca-open-vscode"
            onClick={() => {
              openCode.mutate();
            }}
          >
            <VscodeLogo />
          </Button>
        </div>
        {unavailable.length > 0 && (
          <ul
            className="flex flex-col gap-0.5 text-xs text-muted-foreground"
            data-testid="orca-open-reasons"
          >
            {unavailable.map((w) => (
              <li key={w.key} className="break-words">
                <span className="font-medium text-foreground">{w.label}:</span> {w.reason}
              </li>
            ))}
          </ul>
        )}
      </div>
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      )}
      <dl className="flex flex-col gap-3">
        <Field label="Branch">
          {node.location.branch === null ? (
            <span className="text-muted-foreground">Unknown</span>
          ) : (
            <span className="inline-flex items-center gap-1 font-mono">
              <GitBranch className="size-3.5" aria-hidden />
              {node.location.branch}
            </span>
          )}
        </Field>
        <Field label="Worktree">{node.location.worktree.name}</Field>
        <Field label="Working directory">
          <span className="font-mono text-xs break-all">{node.location.cwd}</span>
        </Field>
        <Field label="Model">
          {node.model === null ? (
            <span className="text-muted-foreground">Unknown</span>
          ) : (
            <span>
              {node.model}
              {node.effort !== null && ` · ${node.effort}`}
            </span>
          )}
        </Field>
        <Field label="Cost">
          {node.costUsd === null ? (
            <span className="text-muted-foreground">No session imported</span>
          ) : (
            formatUsd(node.costUsd)
          )}
        </Field>
        {node.runIds.length > 0 && (
          <Field label={node.runIds.length === 1 ? 'Orca Run' : 'Orca Runs'}>
            <span className="font-mono text-xs break-all">{node.runIds.join(', ')}</span>
          </Field>
        )}
      </dl>
    </div>
  );
}

export function EdgeMessages({ edge, graph }: { edge: ShownEdge; graph: OrcaGraph }) {
  const messages = useQuery(orcaMessagesQuery(edge.sourceMembers, edge.targetMembers));
  const titles = new Map(graph.nodes.map((n) => [n.id, n.title]));
  const name = (members: string[]) =>
    members.length === 1
      ? (titles.get(members[0] ?? '') ?? 'Session')
      : `${String(members.length)} sessions`;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="orca-edge-detail">
      <h3 className="flex min-w-0 flex-col gap-0.5 text-sm font-semibold">
        <span className="break-words">{name(edge.sourceMembers)}</span>
        <span className="text-xs font-normal text-muted-foreground">
          {edge.kind === 'dispatch' ? 'dispatched work to' : 'talked with'}
        </span>
        <span className="break-words">{name(edge.targetMembers)}</span>
      </h3>
      {edge.kind === 'dispatch' && edge.label !== null && (
        <p className="text-xs text-muted-foreground">
          Latest task: <span className="text-foreground">{edge.label}</span>
          {edge.count > 1 && ` (${String(edge.count)} tasks)`}
        </p>
      )}
      {messages.data === undefined ? (
        messages.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {messages.error.message}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Loading messages…</p>
        )
      ) : messages.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No messages between them.</p>
      ) : (
        <ul className="flex flex-col gap-1.5" data-testid="orca-edge-messages">
          {messages.data.map((m) => (
            <li key={m.id} className="flex min-w-0 flex-col gap-0.5 rounded border px-2 py-1.5">
              <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span className="font-mono">
                  {m.source === 'peer' ? 'session message' : m.type}
                </span>
                {m.answered === false && (
                  <Badge variant="outline" data-testid="orca-unanswered">
                    Unanswered
                  </Badge>
                )}
                <span>{time(m.at)}</span>
                <span className="min-w-0 truncate">
                  {titles.get(m.from) ?? m.from} → {titles.get(m.to) ?? m.to}
                </span>
              </span>
              {m.subject !== '' && <span className="text-sm break-words">{m.subject}</span>}
              {m.body !== '' && (
                <details className="group text-xs text-muted-foreground">
                  <summary className="flex cursor-pointer list-none items-start gap-1">
                    <ChevronRight
                      className="mt-0.5 size-3 shrink-0 transition-transform group-open:rotate-90"
                      aria-hidden
                    />
                    <span className="line-clamp-2 group-open:hidden">{m.body}</span>
                  </summary>
                  <p className="mt-1 whitespace-pre-wrap break-words">{m.body}</p>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
