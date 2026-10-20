import path from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';
import {
  basicProjectServices,
  e2eWebDist,
  projectGroups,
  realProjectServices,
  services,
} from './services.js';

// pnpm e2e [参数…] 与 pnpm e2e:real [文件…]：参数原样交给 playwright test。先用 --list 得到这次选中的用例所在的
// project（文件、-g、--project 等筛选按 Playwright 自己的规则），按用到的服务分组后一组一组地运行：
// 经 WFD_E2E_PROJECTS 让配置只保留这一组的 project、只启动它们用到的服务，这一组结束时 Playwright 停掉它的服务，
// 再开下一组。页面在开始前 vite build 一次，各组用 vite preview 提供同一份产物
const tiers = {
  basic: { config: 'playwright.config.ts', projects: basicProjectServices },
  real: { config: 'playwright.real.config.ts', projects: realProjectServices },
} as const;
const [tier, ...args] = process.argv.slice(2);
if (tier !== 'basic' && tier !== 'real')
  throw new Error(`第一个参数必须是 basic 或 real：${String(tier)}`);
const config = path.resolve(import.meta.dirname, '..', tiers[tier].config);
// 本仓库自己的 playwright：execa 的 preferLocal 跳过 PATH 中已有的 node_modules/.bin（pnpm 已放入本仓库的），
// 只把上级目录的放在最前面，仓库在另一个有 node_modules 的目录之下时会用到那里的 playwright
const playwright = path.resolve(import.meta.dirname, '..', 'node_modules/.bin/playwright');
const projectServices = tiers[tier].projects;
if (tier === 'real' && args.length === 0) console.log('运行整个真实档');

interface Suite {
  specs: { tests: { projectName: string }[] }[];
  suites?: Suite[] | undefined;
}
const Suite: z.ZodType<Suite> = z.lazy(() =>
  z.object({
    specs: z.array(z.object({ tests: z.array(z.object({ projectName: z.string() })) })),
    suites: z.array(Suite).optional(),
  }),
);
const ListReport = z.object({ suites: z.array(Suite) });

const listed = await execa(playwright, [
  'test',
  '--config',
  config,
  '--list',
  '--reporter=json',
  ...args,
]);
const projects = new Set<string>();
const collect = (suite: Suite) => {
  for (const spec of suite.specs) for (const t of spec.tests) projects.add(t.projectName);
  for (const child of suite.suites ?? []) collect(child);
};
for (const suite of ListReport.parse(JSON.parse(listed.stdout)).suites) collect(suite);
if (projects.size === 0) throw new Error(`没有选中任何用例：playwright test ${args.join(' ')}`);
const groups = projectGroups(projectServices, [...projects]);
console.log(`选中的 project，按组依次运行：${groups.map((g) => g.join('、')).join(' → ')}`);

const usesPreview = groups
  .flat()
  .some((name) =>
    (projectServices[name] ?? []).some((s) => services[s].command.includes(e2eWebDist)),
  );
if (usesPreview) {
  const t = Date.now();
  await execa(
    'pnpm',
    [
      '--filter',
      '@wf-dashboard/web',
      'exec',
      'vite',
      'build',
      '--outDir',
      e2eWebDist,
      '--emptyOutDir',
      '--logLevel',
      'warn',
    ],
    { stdio: 'inherit' },
  );
  console.log(`页面构建完成，${String(Math.round((Date.now() - t) / 1000))} 秒`);
}

// 选中的 project 已由 --list 按参数得到；每组运行时换成这一组的 --project，其余参数（文件、-g 等）原样保留
const otherArgs = args.filter(
  (arg, i) => arg !== '--project' && args[i - 1] !== '--project' && !arg.startsWith('--project='),
);
for (const [i, group] of groups.entries()) {
  const t = Date.now();
  console.log(
    `\n--- 第 ${String(i + 1)}/${String(groups.length)} 组：${group.join('、')}（${new Date().toISOString()} 开始）`,
  );
  await execa(
    playwright,
    ['test', '--config', config, ...otherArgs, ...group.flatMap((name) => ['--project', name])],
    {
      stdio: 'inherit',
      env: { WFD_E2E_PROJECTS: group.join(','), WFD_E2E_GROUP: group.join('+') },
    },
  );
  console.log(`--- 第 ${String(i + 1)} 组通过，${String(Math.round((Date.now() - t) / 1000))} 秒`);
}
