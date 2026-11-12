import type { LiveSummary } from '@/lib/live-api';

// Tree of the Live list on the left (Contracts 35.4): a worker is indented under the main agent that
// dispatched it, deeper levels indent further

// A row's place in the tree: indent depth, number of workers it dispatched, and how many of them are working
export interface Branch {
  depth: number;
  workers: number;
  working: number;
  collapsed: boolean;
  onToggle: () => void;
}

// Arrange the list as a tree: workers follow their main agent, indented; when collapsed, its workers
// (deeper ones included) are not listed. A worker whose main agent is not in this list (e.g. filtered
// out) is its own row in the original order; items outside the tree have no Branch
export function treeRows(
  items: LiveSummary[],
  collapsed: Set<string>,
  onToggle: (id: string) => void,
): { live: LiveSummary; branch: Branch | null }[] {
  const byId = new Map(items.map((l) => [l.id, l]));
  const children = new Map<string, LiveSummary[]>();
  for (const live of items) {
    const parent = live.orca.parentLiveId;
    if (parent === null || !byId.has(parent)) continue;
    children.set(parent, [...(children.get(parent) ?? []), live]);
  }
  const rows: { live: LiveSummary; branch: Branch | null }[] = [];
  const walk = (live: LiveSummary, depth: number) => {
    const own = children.get(live.id) ?? [];
    const isCollapsed = collapsed.has(live.id);
    const branch: Branch | null =
      own.length === 0 && depth === 0
        ? null
        : {
            depth,
            workers: own.length,
            working: own.filter((w) => w.orca.state === 'working').length,
            collapsed: isCollapsed,
            onToggle: () => {
              onToggle(live.id);
            },
          };
    rows.push({ live, branch });
    if (isCollapsed) return;
    for (const child of own) walk(child, depth + 1);
  };
  for (const live of items) {
    const parent = live.orca.parentLiveId;
    if (parent !== null && byId.has(parent)) continue;
    walk(live, 0);
  }
  return rows;
}
