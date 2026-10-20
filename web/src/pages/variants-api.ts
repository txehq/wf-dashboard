import { type QueryClient, queryOptions } from '@tanstack/react-query';
import { requestJson } from '@/lib/http';

export interface Variant {
  id: string;
  name: string;
  // 基本描述（Contracts 18.3）
  description: string | null;
  // 所属 workflow（Contracts 16.4）
  workflowId: string;
  parentId: string | null;
  // 任意 workflow 的 variant 只有一组 skill，没有基线：为空字符串（Contracts 18.6）
  baseCommit: string;
  skillsHash: string;
  version: string;
  status: 'draft' | 'frozen';
  // 从其他数据目录导入的 variant 没有安装目录
  installDir: string | null;
  // 与另一个 variant 共用的目录（迁移拆出的 lfg 与 ic，Contracts 16.4）；为空时是自己的目录
  storageId: string | null;
  buildStatus: 'none' | 'building' | 'built' | 'failed';
  builtHash: string | null;
  buildError: string | null;
  builtAt: string | null;
  createdAt: string;
  frozenAt: string | null;
  // 由分析的"另存为 variant"建出时的分析 id；按 session 的 skill 新建时的来源 session
  analysisId: string | null;
  sourceSessionId: string | null;
  // 由草稿保存出时的草稿 id（Contracts 17.4）
  draftId: string | null;
  // 删除的时间（Contracts 24.3）：已删除的只保留名字用于显示，不再出现在列表与选择中
  deletedAt: string | null;
  // 自动导入的 txe-workflow release 的 tag（Contracts 29.1）；其他为空
  releaseTag: string | null;
}

export interface VariantOptions {
  models: { alias: string; model: string }[];
  efforts: string[];
}

export interface SkillFile {
  path: string;
  size: number;
}

export interface FileDiff {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldContent: string;
  newContent: string;
  patch: string;
}

export interface VariantDiff {
  against: { kind: 'parent' | 'base'; variantId: string | null; commit: string };
  files: FileDiff[];
}

export const statusLabel: Record<Variant['status'], string> = { draft: '草稿', frozen: '已冻结' };

// 页面中 variant 的名字：名字 (workflow)，例如 基线 (lfg)；已删除的为 名字（已删除） (workflow)
export const variantLabel = (
  variant: Pick<Variant, 'name' | 'workflowId'> & { deletedAt?: string | null },
) =>
  `${variant.name}${variant.deletedAt === undefined || variant.deletedAt === null ? '' : '（已删除）'} (${variant.workflowId})`;

// 全部 variant，包括已删除的（Compare 显示保留的 run，Contracts 24.3）
export const allVariantsQuery = queryOptions({
  queryKey: ['variants', 'with-deleted'],
  queryFn: () =>
    request<(Variant & { boundSessions: number })[]>('GET', '/api/variants?includeDeleted=1'),
});

// variant 的独立页面（Contracts 18.3）
export const variantHref = (variant: Pick<Variant, 'id'>) => `/variants/${variant.id}`;

// 安装到本机的清单（Contracts 18.6）
export interface InstallManifest {
  variantId: string;
  variantName: string;
  workflowId: string;
  installedAt: number;
  targets: { claude: string; agents: string };
  dirs: string[];
  files: { path: string; sha256: string }[];
}

// 按当前内容构建成功、可以运行
export function isBuilt(v: Pick<Variant, 'buildStatus' | 'builtHash' | 'skillsHash'>): boolean {
  return v.buildStatus === 'built' && v.builtHash === v.skillsHash;
}

export function buildLabel(variant: Variant): string {
  // 构建过，之后编辑了内容（服务端把 buildStatus 改回 none，builtHash 仍是上次构建的内容）
  if (
    (variant.buildStatus === 'built' || variant.buildStatus === 'none') &&
    variant.builtHash !== null &&
    variant.builtHash !== variant.skillsHash
  ) {
    return '需要重新构建';
  }
  return { none: '未构建', building: '构建中', built: '已构建', failed: '构建失败' }[
    variant.buildStatus
  ];
}

// 失败时抛出带 URL、状态码与服务端原因的错误
export async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  return (await requestJson(method, url, body)) as T;
}

// 失败后不自动重复请求（重试、窗口聚焦、网络恢复、重新挂载都不触发），由页面上的「重试」重新请求
const notFailed = (query: { state: { status: string } }) => query.state.status !== 'error';
const manualRetry = {
  retry: false,
  retryOnMount: false,
  refetchOnWindowFocus: notFailed,
  refetchOnReconnect: notFailed,
} as const;

// 从其他数据目录导入的 variant：只有 skills 内容，不能编辑、构建与运行
export function isImported(variant: Variant): boolean {
  return variant.installDir === null;
}

export const importedLabel = '导入的 variant（只读，派生后可以构建与运行）';

export const variantsQuery = queryOptions({
  queryKey: ['variants'],
  // 列表中每个 variant 另带绑定的 session 数
  queryFn: () => request<(Variant & { boundSessions: number })[]>('GET', '/api/variants'),
  ...manualRetry,
});

export const variantOptionsQuery = queryOptions({
  queryKey: ['variants', 'options'],
  queryFn: () => request<VariantOptions>('GET', '/api/variants/options'),
  staleTime: Infinity,
  ...manualRetry,
});

export const variantQuery = (id: string) =>
  queryOptions({
    queryKey: ['variants', id],
    queryFn: () => request<Variant>('GET', `/api/variants/${id}`),
    ...manualRetry,
  });

export const filesQuery = (id: string) =>
  queryOptions({
    queryKey: ['variants', id, 'files'],
    queryFn: () => request<SkillFile[]>('GET', `/api/variants/${id}/files`),
    ...manualRetry,
  });

export const fileQuery = (id: string, path: string) =>
  queryOptions({
    queryKey: ['variants', id, 'file', path],
    queryFn: () =>
      request<{ path: string; content: string }>(
        'GET',
        `/api/variants/${id}/file?path=${encodeURIComponent(path)}`,
      ),
    staleTime: Infinity,
    ...manualRetry,
  });

export const diffQuery = (id: string, against: 'base' | 'parent') =>
  queryOptions({
    queryKey: ['variants', id, 'diff', against],
    queryFn: () => request<VariantDiff>('GET', `/api/variants/${id}/diff?against=${against}`),
    ...manualRetry,
  });

export const buildLogQuery = (id: string, building: boolean) =>
  queryOptions({
    queryKey: ['variants', id, 'build-log'],
    queryFn: () => request<string>('GET', `/api/variants/${id}/build-log`),
    ...manualRetry,
    refetchInterval: (query) => (building && notFailed(query) ? 1000 : false),
  });

// 构建开始或结束时重新读取构建日志。面板刚打开、第一次读取还没有回应时，TanStack Query 的 invalidate 沿用进行中的
// 那次读取，它读到的可能是构建结束之前的日志：先取消它再读
export async function refetchBuildLog(client: QueryClient, id: string) {
  const { queryKey } = buildLogQuery(id, false);
  await client.cancelQueries({ queryKey, exact: true });
  await client.invalidateQueries({ queryKey, exact: true });
}

// variant 历史的一条（Contracts 16.4、17.4）：改名，或被草稿覆盖、恢复时存下的原来的 src/。draftEngine 为草稿的
// 引擎（28.4），草稿已删除且覆盖时没有记下时为空
export type HistoryEntry = { id: number; at: number } & (
  | { kind: 'rename'; from: string; to: string }
  | {
      kind: 'overwrite';
      snapshot: string;
      draftId: string;
      draftEngine: 'claude' | 'codex' | null;
      analysisId: string | null;
    }
  | { kind: 'restore'; snapshot: string; restoredEventId: number }
);

export const historyQuery = (id: string) =>
  queryOptions({
    queryKey: ['variants', id, 'history'],
    queryFn: () => request<HistoryEntry[]>('GET', `/api/variants/${id}/history`),
    ...manualRetry,
  });

// 查看历史中存下的 src/：现在的内容恢复成它时逐文件的改动
export const historyDiffQuery = (id: string, eventId: number) =>
  queryOptions({
    queryKey: ['variants', id, 'history', eventId, 'diff'],
    queryFn: () =>
      request<FileDiff[]>('GET', `/api/variants/${id}/history/${String(eventId)}/diff`),
    staleTime: 0,
    ...manualRetry,
  });

export const installQuery = (id: string) =>
  queryOptions({
    queryKey: ['variants', id, 'install'],
    queryFn: () =>
      request<{ installed: InstallManifest | null }>('GET', `/api/variants/${id}/install`),
    ...manualRetry,
  });
