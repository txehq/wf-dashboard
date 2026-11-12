import { queryOptions, useQueryClient } from '@tanstack/react-query';
import type { HostCheck, SshHostList, SshHostView } from '@wf-dashboard/server/remote/views';
import { requestJson } from '@/lib/http';
import { invalidateThrottled, useLiveEvent } from '@/lib/live-events';

// SSH hosts (Contracts 31.1, 31.2)
export type { HostCheck, SshHostList, SshHostView };

export const sshHostsQuery = queryOptions({
  queryKey: ['ssh-hosts'],
  queryFn: async () => (await requestJson('GET', '/api/ssh-hosts')) as SshHostList,
});

// Checked when the new interaction form picks a host (reused for 60 seconds); "Recheck" in Settings does not reuse
export function hostCheckQuery(id: string) {
  return queryOptions({
    queryKey: ['ssh-hosts', 'check', id],
    queryFn: async () =>
      (await requestJson('POST', `/api/ssh-hosts/${id}/check`, { reuse: true })) as SshHostView,
  });
}

export async function addHost(target: string): Promise<SshHostView> {
  return (await requestJson('POST', '/api/ssh-hosts', { target })) as SshHostView;
}

export async function recheckHost(id: string): Promise<SshHostView> {
  return (await requestJson('POST', `/api/ssh-hosts/${id}/check`, {})) as SshHostView;
}

export async function renameHost(id: string, label: string): Promise<SshHostView> {
  return (await requestJson('PATCH', `/api/ssh-hosts/${id}`, { label })) as SshHostView;
}

export async function deleteHost(id: string): Promise<void> {
  await requestJson('DELETE', `/api/ssh-hosts/${id}`);
}

// Reasons in a check result that prevent starting: unreachable, missing tmux, rsync or curl, and the chosen engine missing on the host
export function hostProblems(check: HostCheck, engine: 'claude' | 'codex' | null): string[] {
  const problems = [...check.problems];
  if (check.connected && engine !== null && !check.engines.includes(engine)) {
    problems.push(`${engine === 'claude' ? 'Claude Code' : 'Codex'} not found`);
  }
  return problems;
}

// ssh-hosts.updated: the host list and check results
export function useSshHostEvents() {
  const client = useQueryClient();
  useLiveEvent((type) => {
    if (type !== 'ssh-hosts.updated') return;
    invalidateThrottled(client, ['ssh-hosts'], 300);
  });
}
