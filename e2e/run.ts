import path from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';

// pnpm e2e [参数…] 与 pnpm e2e:real [文件…]：参数原样交给 playwright test。先用 --list 得到这次选中的用例所在的
// project（文件、-g、--project 等筛选按 Playwright 自己的规则），经 WFD_E2E_PROJECTS 让配置只启动它们用到的服务
const configs = { basic: 'playwright.config.ts', real: 'playwright.real.config.ts' } as const;
const [tier, ...args] = process.argv.slice(2);
if (tier !== 'basic' && tier !== 'real')
  throw new Error(`第一个参数必须是 basic 或 real：${String(tier)}`);
const config = path.resolve(import.meta.dirname, '..', configs[tier]);
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

const listed = await execa(
  'playwright',
  ['test', '--config', config, '--list', '--reporter=json', ...args],
  { preferLocal: true },
);
const projects = new Set<string>();
const collect = (suite: Suite) => {
  for (const spec of suite.specs) for (const t of spec.tests) projects.add(t.projectName);
  for (const child of suite.suites ?? []) collect(child);
};
for (const suite of ListReport.parse(JSON.parse(listed.stdout)).suites) collect(suite);
if (projects.size === 0) throw new Error(`没有选中任何用例：playwright test ${args.join(' ')}`);
console.log(`选中的 project：${[...projects].join('、')}`);

await execa('playwright', ['test', '--config', config, ...args], {
  preferLocal: true,
  stdio: 'inherit',
  env: { WFD_E2E_PROJECTS: [...projects].join(',') },
});
