import { queryOptions } from '@tanstack/react-query';
import type { DirList, NewDir } from '@wf-dashboard/server/dirs/views';
import { requestJson } from '@/lib/http';

// Browsing and creating folders (Contracts 31.1, 34.1): directories on an SSH host or on this machine
export type { DirList };

export type DirSource = { kind: 'ssh'; hostId: string } | { kind: 'local' };

const base = (source: DirSource) =>
  source.kind === 'ssh' ? `/api/ssh-hosts/${source.hostId}/dirs` : '/api/local/dirs';

const sourceKey = (source: DirSource) => (source.kind === 'ssh' ? source.hostId : 'local');

export function dirsQuery(source: DirSource, dir: string) {
  return queryOptions({
    queryKey: ['dirs', sourceKey(source), dir],
    queryFn: async () =>
      (await requestJson('GET', `${base(source)}?path=${encodeURIComponent(dir)}`)) as DirList,
  });
}

export async function createDir(source: DirSource, parent: string, name: string): Promise<string> {
  return ((await requestJson('POST', base(source), { parent, name })) as NewDir).path;
}
