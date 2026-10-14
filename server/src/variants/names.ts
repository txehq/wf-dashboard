// 已删除的 variant 与 workflow 保留一行记录，只用于显示名字（Contracts 24.3、24.5）：显示为"<名字>（已删除）"
export const DELETED_SUFFIX = '（已删除）';

export const displayName = (row: { name: string; deletedAt: Date | null }) =>
  row.deletedAt === null ? row.name : `${row.name}${DELETED_SUFFIX}`;
