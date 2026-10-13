import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { createVariants } from '../src/variants/index.js';
import { insertWorkflow } from '../src/workflows/index.js';
import { WorkflowDefinition } from '../src/workflows/schema.js';

// Contracts 18.5、18.6：任意 workflow 的 variant 由 dashboard 自己管理——从空白新建的骨架、不用 wf 的构建、
// 安装到本机与卸载。安装的目标是这个测试进程自己的临时 home（.work/test-data/<进程号>/home），
// 用户真实的 ~/.claude/skills 与 ~/.agents/skills 在测试前后不变
const dataDir = config.dataDir;
const home = path.join(dataDir, 'home');
const work = path.join(config.repoRoot, '.work', 'test-variants-own', randomUUID());
const db = openDatabase(path.join(work, 'db.sqlite'), config.migrationsDir);
const variants = createVariants({
  db,
  dataDir,
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
  home,
});

// 用户真实的两个 skill 目录：路径与 mtime 的清单
const realDirs = [
  path.join(os.homedir(), '.claude', 'skills'),
  path.join(os.homedir(), '.agents', 'skills'),
];
function listing(): string[] {
  return realDirs.flatMap((dir) =>
    fs.existsSync(dir)
      ? fs
          .readdirSync(dir, { recursive: true, withFileTypes: true })
          .map((e) => {
            const file = path.join(e.parentPath, e.name);
            return `${file} ${String(fs.lstatSync(file).mtimeMs)}`;
          })
          .sort()
      : [`${dir} 不存在`],
  );
}
const before = listing();

afterAll(() => {
  const dirs = variants.list().map((v) => variants.layout(v.id).dir);
  db.$client.close();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(path.join(dataDir, 'installs'), { recursive: true, force: true });
  expect(listing()).toEqual(before);
});

// 每个用例自己的 workflow：入口与两个小阶段，名字带随机后缀，不与其他用例的 skill 目录冲突
function newWorkflow() {
  const suffix = randomUUID().slice(0, 6);
  const definition = WorkflowDefinition.parse({
    id: `own-${suffix}`,
    name: `自有 ${suffix}`,
    stages: [{ id: `scan-${suffix}` }, { id: `report-${suffix}`, repeatable: true }],
  });
  insertWorkflow(db, definition, '测试用');
  const draft = variants.createBlank({ workflowId: definition.id, name: '初稿' });
  return { definition, draft };
}

const skillsOf = (dir: string) =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const file = path.join(e.parentPath, e.name);
      return [path.relative(dir, file), fs.readFileSync(file, 'utf8')];
    })
    .sort();

describe('自有管理器的构建（18.6）', () => {
  test('骨架构建通过：variant 的 CLAUDE_CONFIG_DIR/skills 与 src/skills 相同，不运行 wf', async () => {
    const { definition, draft } = newWorkflow();
    const built = await variants.build(draft.id);
    expect([built.buildStatus, built.builtHash]).toEqual(['built', draft.skillsHash]);
    const dirs = variants.layout(draft.id);
    expect(skillsOf(path.join(dirs.claudeDir, 'skills'))).toEqual(skillsOf(dirs.skills));
    expect(skillsOf(dirs.skills).map(([file]) => file)).toEqual(
      [definition.id, ...definition.stages.map((s) => s.id)].sort().map((n) => `${n}/SKILL.md`),
    );
    const settings = JSON.parse(
      fs.readFileSync(path.join(dirs.claudeDir, 'settings.json'), 'utf8'),
    ) as { env: Record<string, string>; claudeMdExcludes: string[] };
    expect(Object.keys(settings.env)).toContain('ANTHROPIC_BASE_URL');
    expect(settings.claudeMdExcludes).toContain(path.join(os.homedir(), '.claude/CLAUDE.md'));
    expect(fs.existsSync(path.join(dirs.codexHome, 'config.toml'))).toBe(true);
    const log = variants.buildLog(draft.id);
    expect(log).toContain(
      `[own] workflow ${definition.id} 的 variant 由 dashboard 管理，没有运行 wf`,
    );
    expect(log).not.toContain('[guard]');
    expect(log).toContain(`=== 构建完成 skills.${draft.skillsHash.slice(0, 8)} ===`);
    // Live 与分析用这份配置目录
    expect(variants.runtimeEnv(draft.id).env.CLAUDE_CONFIG_DIR).toBe(dirs.claudeDir);
  });

  test('frontmatter 缺 name、name 与目录名不同、缺小阶段的 skill，各以原文失败', async () => {
    const { definition, draft } = newWorkflow();
    const [scan, report] = definition.stages.map((s) => s.id);
    const file = (name: string | undefined) => `skills/${String(name)}/SKILL.md`;
    const failure = async (edit: (id: string) => void) => {
      const v = variants.derive(draft.id, { name: randomUUID().slice(0, 8) });
      edit(v.id);
      await expect(variants.build(v.id)).rejects.toThrow();
      const failed = variants.get(v.id);
      expect(failed.buildStatus).toBe('failed');
      return { error: failed.buildError, skills: variants.layout(v.id).skills, name: v.name };
    };

    const noName = await failure((id) =>
      variants.writeFile(id, file(scan), '---\ndescription: 扫描\n---\n'),
    );
    expect(noName.error).toContain(
      `${path.join(noName.skills, String(scan), 'SKILL.md')} 的 frontmatter 不合法：`,
    );
    expect(noName.error).toContain('name');
    const renamed = await failure((id) =>
      variants.writeFile(id, file(report), '---\nname: other\ndescription: 报告\n---\n'),
    );
    expect(renamed.error).toBe(
      `${path.join(renamed.skills, String(report), 'SKILL.md')} 的 frontmatter name 为 other，应与目录名 ${String(report)} 相同`,
    );
    const missing = await failure((id) => variants.deleteSkill(id, String(scan)));
    expect(missing.error).toBe(
      `variant ${missing.name} 缺少 workflow ${definition.id} 要求的 skill：${String(scan)}（应为 src/skills/<名字>/SKILL.md）`,
    );
    // 初稿本身没有被改动
    expect(
      fs.existsSync(path.join(variants.layout(draft.id).skills, String(scan), 'SKILL.md')),
    ).toBe(true);
  });
});

describe('安装到本机与卸载（18.6）', () => {
  const claudeSkills = path.join(home, '.claude', 'skills');
  const agentsSkills = path.join(home, '.agents', 'skills');

  test('安装、冲突时拒绝、同一 workflow 替换、改过的文件拒绝卸载', async () => {
    const { definition, draft } = newWorkflow();
    const names = [definition.id, ...definition.stages.map((s) => s.id)].sort();
    await variants.build(draft.id);
    expect(variants.localInstall(draft.id)).toBeNull();

    // 两个目标目录中各一份，清单记下每个文件的 sha256
    const { manifest, replaced } = variants.installLocal(draft.id);
    expect(replaced).toEqual([]);
    expect(manifest.dirs).toEqual([
      ...names.map((n) => path.join(claudeSkills, n)),
      ...names.map((n) => path.join(agentsSkills, n)),
    ]);
    expect(manifest.files).toHaveLength(names.length * 2);
    expect(skillsOf(claudeSkills)).toEqual(skillsOf(variants.layout(draft.id).skills));
    expect(skillsOf(agentsSkills)).toEqual(skillsOf(variants.layout(draft.id).skills));
    expect(variants.localInstall(draft.id)).toEqual(manifest);
    expect(fs.existsSync(path.join(dataDir, 'installs', `${draft.id}.json`))).toBe(true);

    // 另一个 workflow 的 skill 与一个不是 dashboard 装的目录同名：拒绝并列出，不覆盖
    const other = newWorkflow();
    await variants.build(other.draft.id);
    const foreign = path.join(agentsSkills, other.definition.id);
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, 'SKILL.md'), '用户自己的\n');
    expect(() => variants.installLocal(other.draft.id)).toThrow(
      `这些目录已经存在，不是 dashboard 为 workflow ${other.definition.id} 装的，没有覆盖：\n${foreign}`,
    );
    expect(fs.readFileSync(path.join(foreign, 'SKILL.md'), 'utf8')).toBe('用户自己的\n');
    expect(variants.localInstall(other.draft.id)).toBeNull();
    fs.rmSync(foreign, { recursive: true });

    // 同一 workflow 的另一个 variant：先按清单卸载前一个，再装这一个
    const second = variants.derive(draft.id, { name: '第二版' });
    variants.writeFile(
      second.id,
      `skills/${definition.id}/SKILL.md`,
      `---\nname: ${definition.id}\ndescription: 第二版的入口\n---\n第二版\n`,
    );
    await variants.build(second.id);
    const swapped = variants.installLocal(second.id);
    expect(swapped.replaced.map((m) => m.variantId)).toEqual([draft.id]);
    expect(variants.localInstall(draft.id)).toBeNull();
    expect(fs.readFileSync(path.join(claudeSkills, definition.id, 'SKILL.md'), 'utf8')).toContain(
      '第二版',
    );

    // 改过的文件：拒绝卸载并列出；恢复后卸载，删去文件与空目录
    const edited = path.join(agentsSkills, definition.id, 'SKILL.md');
    const original = fs.readFileSync(edited, 'utf8');
    fs.writeFileSync(edited, `${original}改了\n`);
    expect(() => variants.uninstallLocal(second.id)).toThrow(
      `这些文件在安装后被改过，没有卸载（先把改动移走或恢复原样）：\n${edited}`,
    );
    fs.writeFileSync(edited, original);
    variants.uninstallLocal(second.id);
    expect(variants.localInstall(second.id)).toBeNull();
    for (const dir of swapped.manifest.dirs) expect(fs.existsSync(dir)).toBe(false);

    // 没有按当前内容构建时不能安装
    variants.writeFile(second.id, `skills/${definition.id}/SKILL.md`, `${original}又改了\n`);
    expect(() => variants.installLocal(second.id)).toThrow(
      '还没有按当前内容构建，构建通过后才能安装到本机',
    );
  });
});
