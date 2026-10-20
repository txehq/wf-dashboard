import type { WorkflowDefinition } from '@wf-dashboard/server/workflows/schema';
import { describe, expect, test } from 'vitest';
import { fitZoom, flowLayout, MIN_FLOW_ZOOM } from '@/components/workflow-flow-size';
import { bindingKindLabel, tableBindingNote } from '@/lib/analyses-api';
import { againstOptions, chosenAgainst } from '@/lib/workspace-api';

// 基础档（Contracts 28.4、28.5）：流程图的节点宽度与缩放、"对比"可以选的对象、"run 所用"只写给 run 的 session
describe('流程图的布局与缩放', () => {
  const definition: WorkflowDefinition = {
    id: 'weekly-report',
    name: '写周报',
    stages: [
      { id: 'collect' },
      { id: 'draft' },
      { id: 'revise', repeatable: true },
      { id: 'publish' },
    ],
  };

  test('节点按文字定宽，入口的 /weekly-report 放得下；节点依次排开', () => {
    const layout = flowLayout(definition, true);
    expect(layout.nodes.map((n) => n.id)).toEqual([
      'weekly-report',
      'collect',
      'draft',
      'revise',
      'publish',
    ]);
    const entry = layout.nodes[0];
    if (entry === undefined) throw new Error('没有入口节点');
    // 14 个字符，每个 7.5 px，加左右边距
    expect(entry.width).toBeGreaterThanOrEqual(14 * 7.5 + 16);
    for (let i = 1; i < layout.nodes.length; i++) {
      const before = layout.nodes[i - 1];
      const node = layout.nodes[i];
      if (before === undefined || node === undefined) throw new Error('节点缺少');
      expect(node.x).toBeGreaterThan(before.x + before.width);
    }
  });

  test('缩放到框内：不放大；W82 的 1440 宽面板（约 410 px）中 5 个节点整张可见；太窄时停在下限', () => {
    const size = flowLayout(definition, true);
    expect(fitZoom(size, { width: 2000, height: null })).toBe(1);
    const zoom = fitZoom(size, { width: 410, height: null });
    expect(zoom).toBeGreaterThan(MIN_FLOW_ZOOM);
    expect(size.width * zoom).toBeLessThanOrEqual(410);
    expect(fitZoom(size, { width: 410, height: size.height / 2 })).toBe(MIN_FLOW_ZOOM);
    expect(fitZoom(size, { width: 100, height: null })).toBe(MIN_FLOW_ZOOM);
  });
});

describe('对比的对象', () => {
  const at = new Date(2026, 9, 16, 20, 21).getTime();

  test('有底子时依次为底子、上次保存、上一版；空白新建没有底子；没有的不列出', () => {
    expect(
      againstOptions({
        base: { id: 'v', name: '初稿' },
        against: { saved: { at }, previous: { at: at + 60_000 } },
      }),
    ).toEqual([
      { value: 'base', label: '底子' },
      { value: 'saved', label: '上次保存 20:21' },
      { value: 'previous', label: '上一版 20:22' },
    ]);
    expect(againstOptions({ base: null, against: { saved: null, previous: { at } } })).toEqual([
      { value: 'previous', label: '上一版 20:21' },
    ]);
    expect(againstOptions({ base: null, against: { saved: null, previous: null } })).toEqual([]);
  });

  test('记下的选择还在时用它，否则用第一个可用的，都没有时为 null', () => {
    const options = againstOptions({ base: null, against: { saved: { at }, previous: { at } } });
    expect(chosenAgainst(options, 'previous')).toBe('previous');
    expect(chosenAgainst(options, 'base')).toBe('saved');
    expect(chosenAgainst([], 'base')).toBeNull();
  });
});

describe('run 所用', () => {
  test('表格：run 的 session 写 run id，Live 交互的（绑定种类 run、没有 run）不写，其余写绑定种类', () => {
    expect(tableBindingNote({ variantBinding: 'run', runId: 'r-20261009-27yz3d' })).toEqual({
      run: 'r-20261009-27yz3d',
    });
    expect(tableBindingNote({ variantBinding: 'run', runId: null })).toBeNull();
    expect(tableBindingNote({ variantBinding: 'auto', runId: null })).toEqual({ label: '自动' });
    expect(tableBindingNote({ variantBinding: 'manual', runId: null })).toEqual({ label: '手动' });
    expect(tableBindingNote({ variantBinding: null, runId: null })).toBeNull();
  });

  test('详情的绑定标签：Live 交互的写交互所用', () => {
    expect(bindingKindLabel('run', true)).toBe('run 所用');
    expect(bindingKindLabel('run', false)).toBe('交互所用');
    expect(bindingKindLabel('auto', false)).toBe('自动');
  });
});
