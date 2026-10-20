import { WorkflowView } from '@wf-dashboard/server/workflows/schema';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { isBuilt, type Variant } from '@/pages/variants-api';
import variantsJson from './fixtures/release-variants.json';
import workflowsJson from './fixtures/release-workflows.json';
import { defaultBatchVariants, defaultLiveVariant, latestReleaseVariant } from './workflows-api';

// W91 实测的服务录下的 GET /api/workflows 与 GET /api/variants：lfg、ic 各有构建好的 txe-workflow v2.3.0
const workflows = z.array(WorkflowView).parse(workflowsJson);
const variants = variantsJson as Variant[];
const lfg = variants.find((v) => v.workflowId === 'lfg');
const ic = variants.find((v) => v.workflowId === 'ic');

test('发起 batch 默认选 lfg、ic 最新版的 variant；选了 task 后只取同一评测类型的（Contracts 29.1）', () => {
  if (lfg === undefined || ic === undefined) throw new Error('fixture 中没有 lfg、ic 的 variant');
  expect(lfg).toMatchObject({ name: 'txe-workflow v2.3.0', releaseTag: 'v2.3.0' });
  expect(defaultBatchVariants(workflows, variants, [])).toEqual([lfg.id, ic.id]);
  expect(defaultBatchVariants(workflows, variants, ['ic'])).toEqual([ic.id]);
  expect(defaultBatchVariants(workflows, variants, ['lfg', 'ic'])).toEqual([lfg.id, ic.id]);
  // 列表还没有读到时没有默认
  expect(defaultBatchVariants(undefined, variants, [])).toEqual([]);
});

test('最新版的 variant 没有按当前内容构建成功时不默认选', () => {
  if (lfg === undefined) throw new Error('fixture 中没有 lfg 的 variant');
  expect(latestReleaseVariant(workflows, variants, 'lfg')?.id).toBe(lfg.id);
  const edited = variants.map((v) =>
    v.id === lfg.id ? { ...v, skillsHash: 'edited', buildStatus: 'none' as const } : v,
  );
  expect(latestReleaseVariant(workflows, edited, 'lfg')).toBeNull();
  expect(latestReleaseVariant(workflows, variants, 'session-analysis')).toBeNull();
});

test('Live 的新建交互默认配置是 lfg 最新版的 variant；它没有构建成功时为 lfg 的其他 variant（Contracts 29.1）', () => {
  if (lfg === undefined || ic === undefined) throw new Error('fixture 中没有 lfg、ic 的 variant');
  // 手动导入的 lfg variant 排在最新版之前
  const manual = { ...lfg, id: 'manual-lfg', name: '基线', releaseTag: null };
  const withManual = [ic, manual, ...variants.filter((v) => v.id !== ic.id)];
  expect(defaultLiveVariant(workflows, withManual.filter(isBuilt))?.id).toBe(lfg.id);
  const edited = withManual.map((v) =>
    v.id === lfg.id ? { ...v, skillsHash: 'edited', buildStatus: 'none' as const } : v,
  );
  expect(defaultLiveVariant(workflows, edited.filter(isBuilt))?.id).toBe(manual.id);
  // workflow 列表还没有读到时同样先用 lfg 的第一个
  expect(defaultLiveVariant(undefined, withManual.filter(isBuilt))?.id).toBe(manual.id);
  expect(defaultLiveVariant(workflows, [ic])?.id).toBe(ic.id);
  expect(defaultLiveVariant(workflows, [])).toBeNull();
});
