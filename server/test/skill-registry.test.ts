import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, test } from 'vitest';
import { config } from '../src/config.js';
import { createVariants } from '../src/variants/index.js';
import { registerSkills } from '../src/variants/skill-registry.js';
import { openTestDb } from './stages/db.js';

// Contracts 16.4：variant 中新增、删除的 skill 目录在构建前登记进 workflow/registry.yaml 与 docs/index.yaml（含 feature
// record），改动写回 src/ 并记进构建日志；没有增删时不改这些文件
const { db, close } = openTestDb();
// 真实构建；基线导出、wf runtime 与 cargo 缓存在 .work/test-data，跨测试运行复用
const variants = createVariants({
  db,
  dataDir: path.join(config.repoRoot, '.work', 'test-data'),
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
});
const created: string[] = [];
afterAll(() => {
  for (const id of created) fs.rmSync(variants.layout(id).dir, { recursive: true, force: true });
  close();
});

const read = (src: string, file: string) => fs.readFileSync(path.join(src, file), 'utf8');
const files = ['workflow/registry.yaml', 'docs/index.yaml'];

describe('新增与删除 skill 目录的登记', { timeout: 900_000 }, () => {
  test('只新增一个 skill 的 variant：构建通过，wf status 0 退出，登记写回 src/', async () => {
    const v = await variants.createBaseline({ name: `W36 登记 ${randomUUID().slice(0, 8)}` });
    created.push(v.id);
    const src = variants.layout(v.id).src;
    const before = files.map((f) => read(src, f));
    variants.writeFile(
      v.id,
      'skills/scope/SKILL.md',
      '---\nname: scope\ndescription: next-workflow 的 scope 阶段\n---\n\n# scope\n',
    );
    const built = await variants.build(v.id);
    expect(built.buildStatus).toBe('built');
    const log = variants.buildLog(v.id);
    expect(log).toContain('[register-skills] 登记 scope；删去 （无）');
    expect(log).toContain('[status] exit 0');
    const registry = read(src, 'workflow/registry.yaml');
    expect(registry).toContain(
      '  - id: capso.skill.scope\n    kind: skill\n    source: skills/scope\n    required: true\n',
    );
    // 只插入新的一段，其余内容逐字节不变
    expect(registry.replace(/\n {2}- id: capso\.skill\.scope\n(?: {4}.*\n)+/, '')).toBe(before[0]);
    expect(read(src, 'docs/index.yaml')).toContain('    name: scope\n    invocation: /scope\n');
    expect(read(src, 'docs/product/features/scope.md')).toContain('# /scope');

    // 再次登记：没有增删，不改任何文件
    const again = files.map((f) => read(src, f));
    expect(registerSkills(src)).toEqual({ added: [], removed: [] });
    expect(files.map((f) => read(src, f))).toEqual(again);
  });

  test('删除 skill 目录：从 registry、名单与 docs 中删去，feature record 一并删除', async () => {
    const v = await variants.createBaseline({ name: `W36 删除 ${randomUUID().slice(0, 8)}` });
    created.push(v.id);
    const src = variants.layout(v.id).src;
    expect(read(src, 'workflow/registry.yaml')).toContain('source: skills/decide');
    fs.rmSync(path.join(src, 'skills/decide'), { recursive: true });
    expect(registerSkills(src)).toEqual({ added: [], removed: ['decide'] });
    expect(read(src, 'workflow/registry.yaml')).not.toContain('source: skills/decide');
    expect(read(src, 'docs/index.yaml')).not.toContain('name: decide\n');
    expect(read(src, 'docs/index.yaml')).not.toContain('docs/product/features/decide.md');
    expect(fs.existsSync(path.join(src, 'docs/product/features/decide.md'))).toBe(false);
  });
});
