import { expect, test } from 'vitest';
import { configGroups, matchesConfig } from './config-groups';
import type { ImportConfig } from './sessions-api';

const lfg = { id: 'lfg', name: 'lfg' };
const ic = { id: 'ic', name: 'ic' };
const config = (id: string, label: string, workflow: ImportConfig['workflow']): ImportConfig => ({
  id,
  label,
  workflow,
  sessionCount: 0,
});
const configs = [
  config('local', '本机配置', null),
  config('variant:a', '基线', lfg),
  config('variant:b', 'interview 追问边界', lfg),
  config('variant:c', '基线', ic),
  config('design', '设计与优化', null),
];

test('相邻的同一 workflow 的配置合为一组，本机配置与设计与优化不在组中', () => {
  expect(
    configGroups(configs).map((g) => [g.workflow?.id ?? null, g.configs.map((c) => c.id)]),
  ).toEqual([
    [null, ['local']],
    ['lfg', ['variant:a', 'variant:b']],
    ['ic', ['variant:c']],
    [null, ['design']],
  ]);
});

test('搜索配置的名字或 workflow 的名字', () => {
  expect(configs.filter((c) => matchesConfig(c, ' IC ')).map((c) => c.id)).toEqual(['variant:c']);
  expect(configs.filter((c) => matchesConfig(c, '追问')).map((c) => c.id)).toEqual(['variant:b']);
  expect(configs.filter((c) => matchesConfig(c, '基线')).map((c) => c.id)).toEqual([
    'variant:a',
    'variant:c',
  ]);
});
