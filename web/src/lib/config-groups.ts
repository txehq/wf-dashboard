import type { ImportConfig } from '@/lib/sessions-api';

export interface ConfigGroup {
  // The workflow a variant config belongs to, used as the group heading; null for local config, which is in no group
  workflow: { id: string; name: string } | null;
  configs: ImportConfig[];
}

// First-column configs grouped by workflow (Contracts 25.1, 33.3): the server returns local config first, then each
// workflow's variants in order; adjacent configs of the same workflow form one group
export function configGroups(configs: ImportConfig[]): ConfigGroup[] {
  const groups: ConfigGroup[] = [];
  for (const c of configs) {
    const last = groups.at(-1);
    if (last !== undefined && last.workflow !== null && last.workflow.id === c.workflow?.id)
      last.configs.push(c);
    else groups.push({ workflow: c.workflow, configs: [c] });
  }
  return groups;
}

// First-column search: q appears in the config name or its workflow's name (case-insensitive)
export function matchesConfig(c: ImportConfig, q: string): boolean {
  const text = q.trim().toLowerCase();
  return (
    c.label.toLowerCase().includes(text) || (c.workflow?.name.toLowerCase().includes(text) ?? false)
  );
}
