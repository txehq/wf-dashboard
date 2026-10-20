import {
  type DiskPick,
  pickedSessions,
  type ScopeInput,
  type ScopeSession,
} from '@/lib/analyses-api';
import type { DiskSession, ImportConfig, SessionEngine } from '@/lib/sessions-api';

// 新建分析中的选择（Contracts 25.4、27）：一次分析的全部 session 属于同一个配置、同一种引擎。
// 从磁盘选的带着文件、所在的配置与引擎、标题与项目（范围读到之前就能显示与灰显）；带着选择进入的只有 id
export interface Picked {
  id: string;
  disk: {
    file: string;
    engine: SessionEngine;
    config: string;
    title: string | null;
    project: string;
  } | null;
}

export const SAME_CONFIG_REASON = '一次分析只能选同一个配置的 session，先清空已选';
export const DESIGN_REASON = '设计与优化的 session 不能分析';

// 已选的所在的配置与引擎：第一个已选的（带着选择进入的按读到的范围）；还没有选或还没有读到时为 null
export interface PickLock {
  engine: SessionEngine;
  config: string | null;
}

export function pickLock(
  picked: readonly Picked[],
  scoped: ReadonlyMap<string, ScopeSession>,
): PickLock | null {
  const first = picked[0];
  if (first === undefined) return null;
  if (first.disk !== null) return { engine: first.disk.engine, config: first.disk.config };
  const s = scoped.get(first.id);
  return s === undefined ? null : { engine: s.engine, config: s.config?.id ?? null };
}

// 第一列中不能点选的配置：设计与优化始终不能；已选了之后其他配置不能
export function configBlock(c: ImportConfig, lock: PickLock | null): string | null {
  if (c.id === 'design') return DESIGN_REASON;
  if (lock?.config == null || lock.config === c.id) return null;
  return SAME_CONFIG_REASON;
}

// 顶部的引擎切换：已选了之后另一种引擎不能
export const engineBlock = (engine: SessionEngine, lock: PickLock | null): string | null =>
  lock === null || lock.engine === engine ? null : SAME_CONFIG_REASON;

// 第三列勾选或取消（本页全选时为本页全部）：加入的接在后面，已选的不重复
export function toggledPicks(
  picked: readonly Picked[],
  list: readonly DiskSession[],
  want: boolean,
  place: { engine: SessionEngine; config: string; project: string },
): Picked[] {
  if (!want) {
    const gone = new Set(list.map((s) => s.id));
    return picked.filter((p) => !gone.has(p.id));
  }
  const have = new Set(picked.map((p) => p.id));
  const added = list
    .filter((s) => !have.has(s.id))
    .map((s) => ({ id: s.id, disk: { file: s.file, title: s.title, ...place } }));
  return [...picked, ...added];
}

// 范围的请求：带着选择进入的按 id，从磁盘选的按文件
export function pickedScope(picked: readonly Picked[]): {
  sessions: string[];
  disk: DiskPick | undefined;
} {
  const fromDisk = picked.flatMap((p) => (p.disk === null ? [] : [p.disk]));
  const first = fromDisk[0];
  return {
    sessions: picked.filter((p) => p.disk === null).map((p) => p.id),
    disk:
      first === undefined
        ? undefined
        : { engine: first.engine, files: fromDisk.map((d) => d.file) },
  };
}

// 从 Sessions、Runs、session 详情带着选择进入（?batch=、?picked=、?sessions=）。
// picked 是 Sessions 表格选中的 session 在本标签页的 sessionStorage 中的键；读不到时为 'missing'
export function preselection(params: URLSearchParams): ScopeInput | 'missing' | null {
  const batch = params.get('batch');
  if (batch !== null && batch !== '') return { batch };
  const picked = params.get('picked');
  if (picked !== null && picked !== '') {
    const ids = pickedSessions(picked);
    return ids === null ? 'missing' : { sessions: ids };
  }
  const sessions = params.get('sessions');
  if (sessions !== null && sessions !== '') return { sessions: sessions.split(',') };
  return null;
}
