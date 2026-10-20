import { expect, test } from 'vitest';
import type { ScopeSession } from './analyses-api';
import {
  configBlock,
  DESIGN_REASON,
  engineBlock,
  type Picked,
  pickedScope,
  pickLock,
  preselection,
  SAME_CONFIG_REASON,
  toggledPicks,
} from './analysis-pick';
import type { DiskSession, ImportConfig } from './sessions-api';

const disk = (id: string): DiskSession => ({
  id,
  file: `/p/${id}.jsonl`,
  title: `标题 ${id}`,
  startedAt: '2026-10-16T00:00:00.000Z',
  size: 1,
  imported: false,
  liveId: null,
  liveHidden: false,
});
const config = (id: string): ImportConfig => ({ id, label: id, workflow: null, sessionCount: 1 });
const here = { engine: 'claude' as const, config: 'local', project: 'wf' };

test('第三列勾选：加入的接在后面、带着文件与所在的配置，已选的不重复；取消时去掉', () => {
  const before: Picked[] = [{ id: 'x', disk: null }];
  const added = toggledPicks(before, [disk('a'), disk('b')], true, here);
  expect(added).toEqual([
    { id: 'x', disk: null },
    { id: 'a', disk: { file: '/p/a.jsonl', title: '标题 a', ...here } },
    { id: 'b', disk: { file: '/p/b.jsonl', title: '标题 b', ...here } },
  ]);
  expect(toggledPicks(added, [disk('a')], true, here)).toEqual(added);
  expect(toggledPicks(added, [disk('a'), disk('x')], false, here).map((p) => p.id)).toEqual(['b']);
  // 范围的请求：带着选择进入的按 id，从磁盘选的按文件
  expect(pickedScope(added)).toEqual({
    sessions: ['x'],
    disk: { engine: 'claude', files: ['/p/a.jsonl', '/p/b.jsonl'] },
  });
  expect(pickedScope(before)).toEqual({ sessions: ['x'], disk: undefined });
});

test('已选的所在的配置与引擎：第一个已选的；带着选择进入的按读到的范围', () => {
  expect(pickLock([], new Map())).toBeNull();
  const fromDisk = toggledPicks([], [disk('a')], true, { ...here, config: 'variant:v1' });
  expect(pickLock(fromDisk, new Map())).toEqual({ engine: 'claude', config: 'variant:v1' });
  const pre: Picked[] = [{ id: 'x', disk: null }];
  expect(pickLock(pre, new Map())).toBeNull();
  const scoped = {
    id: 'x',
    engine: 'codex',
    config: { id: 'local', label: '本机配置' },
  } as ScopeSession;
  expect(pickLock(pre, new Map([['x', scoped]]))).toEqual({ engine: 'codex', config: 'local' });
});

test('灰显：设计与优化始终不能选；已选了之后其他配置与另一种引擎不能选，清空后恢复', () => {
  expect(configBlock(config('design'), null)).toBe(DESIGN_REASON);
  expect(configBlock(config('local'), null)).toBeNull();
  const lock = { engine: 'claude' as const, config: 'local' };
  expect(configBlock(config('local'), lock)).toBeNull();
  expect(configBlock(config('variant:v1'), lock)).toBe(
    '一次分析只能选同一个配置的 session，先清空已选',
  );
  expect(engineBlock('claude', lock)).toBeNull();
  expect(engineBlock('codex', lock)).toBe(SAME_CONFIG_REASON);
  expect(engineBlock('codex', null)).toBeNull();
});

test('带着选择进入：?batch=、?sessions=；都没有时为 null', () => {
  expect(preselection(new URLSearchParams('batch=b-1'))).toEqual({ batch: 'b-1' });
  expect(preselection(new URLSearchParams('sessions=a,b'))).toEqual({ sessions: ['a', 'b'] });
  expect(preselection(new URLSearchParams(''))).toBeNull();
  expect(preselection(new URLSearchParams('sessions='))).toBeNull();
});
