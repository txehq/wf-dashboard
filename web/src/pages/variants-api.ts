import { queryOptions } from '@tanstack/react-query';

export interface Variant {
  id: string;
  name: string;
  parentId: string | null;
  baseCommit: string;
  skillsHash: string;
  version: string;
  model: string;
  effort: string;
  status: 'draft' | 'frozen';
  // 从其他数据目录导入的 variant 没有安装目录
  installDir: string | null;
  buildStatus: 'none' | 'building' | 'built' | 'failed';
  builtHash: string | null;
  buildError: string | null;
  builtAt: string | null;
  createdAt: string;
  frozenAt: string | null;
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

export function buildLabel(variant: Variant): string {
  if (variant.buildStatus === 'built' && variant.builtHash !== variant.skillsHash) {
    return '需要重新构建';
  }
  return { none: '未构建', building: '构建中', built: '已构建', failed: '构建失败' }[
    variant.buildStatus
  ];
}

// 失败时抛出服务端返回的 message
export async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(url, init);
  if (!response.ok) {
    const error = (await response.json()) as { message: string };
    throw new Error(error.message);
  }
  const json = response.headers.get('content-type')?.startsWith('application/json') === true;
  return (json ? await response.json() : await response.text()) as T;
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

export const importedLabel = '导入的 variant（只读，不可构建与运行）';

export const variantsQuery = queryOptions({
  queryKey: ['variants'],
  queryFn: () => request<Variant[]>('GET', '/api/variants'),
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
