import type { ImportConfig } from '@/lib/sessions-api';

export interface ConfigGroup {
  // variant 的配置所属的 workflow，作为组的标题；本机配置、设计与优化不在组中，为 null
  workflow: { id: string; name: string } | null;
  configs: ImportConfig[];
}

// 第一列的配置按 workflow 分组（Contracts 25.1）：服务端已按本机配置、各 workflow 的 variant、设计与优化的顺序返回，
// 相邻的同一 workflow 的配置合为一组
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

// 第一列的搜索：配置的名字或所属 workflow 的名字中含有 q（不分大小写）
export function matchesConfig(c: ImportConfig, q: string): boolean {
  const text = q.trim().toLowerCase();
  return (
    c.label.toLowerCase().includes(text) || (c.workflow?.name.toLowerCase().includes(text) ?? false)
  );
}
