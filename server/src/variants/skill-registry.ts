import fs from 'node:fs';
import path from 'node:path';
import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from 'yaml';

// 新 workflow 的 variant 会新增、删除 skill 目录（Contracts 16.4）：wf guard 要求 src/skills 中的每个 skill 都登记在
// workflow/registry.yaml 的 components 与 docs/index.yaml 的 skills 名单中，并有 feature record 及其 docs 登记。
// 构建前按清单中已有 skill 条目的格式补登记新的 skill，删去目录已不存在的 skill；没有增删时不改任何文件。
// 条目的位置取自 yaml 的 Document 解析出的 range，只在这些位置插入或删去整段原文，其余内容逐字节不变

const REGISTRY = 'workflow/registry.yaml';
const ROSTER = 'docs/index.yaml';
const FEATURES = 'docs/product/features';
export const REGISTRY_FILES = [REGISTRY, ROSTER, FEATURES];

export interface SkillRegistration {
  added: string[];
  removed: string[];
}

// src/skills 下有 SKILL.md 的目录
function skillDirs(srcDir: string): string[] {
  const dir = path.join(srcDir, 'skills');
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort();
}

// 一个 YAML 文件中某个块列表的各项，以及每项在原文中的整行范围（从该项 "- " 所在行的行首到下一项之前）
interface Item {
  map: YAMLMap;
  start: number;
  end: number;
}

function listItems(text: string, key: string, file: string): Item[] {
  const doc = parseDocument(text);
  if (doc.errors.length > 0)
    throw new Error(`${file} 不是合法的 YAML：${doc.errors[0]?.message ?? ''}`);
  const seq = doc.get(key, true);
  if (!isSeq(seq)) throw new Error(`${file} 的 ${key} 不是列表`);
  return seq.items.map((item) => {
    if (!isMap(item) || item.range == null) throw new Error(`${file} 的 ${key} 中有不是映射的一项`);
    const start = text.lastIndexOf('\n', item.range[0]) + 1;
    // 到这一项最后一个值所在行的行尾（含换行）；项之间的空行与注释留给下一项
    const lineEnd = text.indexOf('\n', item.range[1] - 1);
    return { map: item, start, end: lineEnd === -1 ? text.length : lineEnd + 1 };
  });
}

const str = (map: YAMLMap, key: string): string | null => {
  const v = map.get(key, true);
  return isScalar(v) && typeof v.value === 'string' ? v.value : null;
};

interface Splice {
  at: number;
  remove: number;
  insert: string;
}

function apply(text: string, splices: Splice[]): string {
  let out = text;
  for (const s of [...splices].sort((a, b) => b.at - a.at)) {
    out = out.slice(0, s.at) + s.insert + out.slice(s.at + s.remove);
  }
  return out;
}

// 以 template 那一项的原文为格式：把其中的字段值换成新的值（字段值在这一项中只出现一次）
function cloneText(text: string, template: Item, replace: [string, string][]): string {
  let out = text.slice(template.start, template.end);
  for (const [from, to] of replace) {
    if (out.split(from).length !== 2) throw new Error(`作格式的条目中 ${from} 不是恰好出现一次`);
    out = out.replace(from, to);
  }
  return out;
}

// registry 的 skill 条目：kind skill，source skills/<名字>
const registryName = (map: YAMLMap) => {
  const source = str(map, 'source');
  return str(map, 'kind') === 'skill' && source?.startsWith('skills/') === true
    ? source.slice('skills/'.length)
    : null;
};

// 名单中已上线（shipped）的 skill
const rosterName = (map: YAMLMap) => (str(map, 'status') === 'shipped' ? str(map, 'name') : null);

const featurePath = (name: string) => `${FEATURES}/${name}.md`;

export function registerSkills(srcDir: string): SkillRegistration {
  const dirs = skillDirs(srcDir);

  const registryFile = path.join(srcDir, REGISTRY);
  const registryText = fs.readFileSync(registryFile, 'utf8');
  const components = listItems(registryText, 'components', registryFile);
  const registered = components.filter((c) => registryName(c.map) !== null);
  const template = registered[0];
  const lastSkill = registered.at(-1);
  if (template === undefined || lastSkill === undefined) {
    throw new Error(`${registryFile} 中没有 skill 条目可作格式`);
  }
  const templateName = registryName(template.map) ?? '';
  const registeredNames = registered.map((c) => registryName(c.map));
  const added = dirs.filter((d) => !registeredNames.includes(d));
  const removedRegistry = registered.filter((c) => !dirs.includes(registryName(c.map) ?? ''));
  const registrySplices: Splice[] = [
    // 新条目接在最后一个 skill 条目之后
    {
      at: lastSkill.end,
      remove: 0,
      insert: added
        .map(
          (name) =>
            `\n${cloneText(registryText, template, [
              [`capso.skill.${templateName}`, `capso.skill.${name}`],
              [`skills/${templateName}`, `skills/${name}`],
            ])}`,
        )
        .join(''),
    },
    ...removedRegistry.map((c) => ({ at: c.start, remove: c.end - c.start, insert: '' })),
  ];

  const rosterFile = path.join(srcDir, ROSTER);
  const rosterText = fs.readFileSync(rosterFile, 'utf8');
  const rows = listItems(rosterText, 'skills', rosterFile);
  const shipped = rows.filter((r) => rosterName(r.map) !== null);
  const rowTemplate = shipped.find((r) => rosterName(r.map) === templateName) ?? shipped[0];
  const lastRow = rows.at(-1);
  if (rowTemplate === undefined || lastRow === undefined) {
    throw new Error(`${rosterFile} 的 skills 中没有已上线的 skill 可作格式`);
  }
  const shippedNames = shipped.map((r) => rosterName(r.map));
  const rosterAdded = dirs.filter((d) => !shippedNames.includes(d));
  const removedRows = shipped.filter((r) => !dirs.includes(rosterName(r.map) ?? ''));
  // 名单一项：名字与调用换成新的 skill，note 写明来源（note 可能是多行的折叠文字，整段替换）
  const rowText = (name: string) => {
    const base = rosterText.slice(rowTemplate.start, rowTemplate.end);
    const lines = base.split('\n');
    const noteAt = lines.findIndex((l) => /^\s*note:/.test(l));
    const indent = /^(\s*)/.exec(lines[noteAt] ?? '')?.[1] ?? '';
    const kept = noteAt === -1 ? lines : lines.slice(0, noteAt);
    const replaced = kept
      .join('\n')
      .replace(`name: ${rosterName(rowTemplate.map) ?? ''}`, `name: ${name}`)
      .replace(`invocation: ${str(rowTemplate.map, 'invocation') ?? ''}`, `invocation: /${name}`);
    return `${replaced}\n${indent}note: wf-dashboard 为 variant 登记的 skill ${name}。\n`;
  };

  const docs = listItems(rosterText, 'docs', rosterFile);
  const docTemplate = docs.find((d) => str(d.map, 'path') === featurePath(templateName));
  if (docTemplate === undefined) {
    throw new Error(`${rosterFile} 的 docs 中没有 ${featurePath(templateName)} 可作格式`);
  }
  const docPaths = docs.map((d) => str(d.map, 'path'));
  const docsAdded = dirs.filter((d) => !docPaths.includes(featurePath(d)));
  const docsRemoved = docs.filter((d) => {
    const p = str(d.map, 'path');
    return p !== null && removedRows.some((r) => p === featurePath(rosterName(r.map) ?? ''));
  });
  const templatePurpose = str(docTemplate.map, 'purpose') ?? '';
  const templateReadWhen = str(docTemplate.map, 'read_when') ?? '';
  const rosterSplices: Splice[] = [
    {
      at: docTemplate.start,
      remove: 0,
      insert: docsAdded
        .map(
          (name) =>
            `${cloneText(rosterText, docTemplate, [
              [featurePath(templateName), featurePath(name)],
              [templatePurpose, `What /${name} is.`],
              [templateReadWhen, `before invoking or changing /${name}`],
            ])}\n`,
        )
        .join(''),
    },
    ...docsRemoved.map((d) => ({ at: d.start, remove: d.end - d.start, insert: '' })),
    {
      at: lastRow.end,
      remove: 0,
      insert: rosterAdded.map((name) => `\n${rowText(name)}`).join(''),
    },
    ...removedRows.map((r) => ({ at: r.start, remove: r.end - r.start, insert: '' })),
  ];

  const changed = (splices: Splice[]) => splices.some((s) => s.insert !== '' || s.remove > 0);
  if (changed(registrySplices))
    fs.writeFileSync(registryFile, apply(registryText, registrySplices));
  if (changed(rosterSplices)) fs.writeFileSync(rosterFile, apply(rosterText, rosterSplices));
  for (const name of docsAdded) {
    const file = path.join(srcDir, featurePath(name));
    if (fs.existsSync(file)) continue;
    fs.writeFileSync(
      file,
      `---\nlast-verified: ${new Date().toISOString().slice(0, 10)}\n---\n\n# /${name}\n\n**Status:** shipped · **Skill:** [\`skills/${name}/SKILL.md\`](../../../skills/${name}/SKILL.md)\n\nwf-dashboard 为 variant 登记的 skill ${name}。\n`,
    );
  }
  const removed = [
    ...new Set([
      ...removedRegistry.map((c) => registryName(c.map) ?? ''),
      ...removedRows.map((r) => rosterName(r.map) ?? ''),
    ]),
  ].sort();
  for (const name of removed) fs.rmSync(path.join(srcDir, featurePath(name)), { force: true });
  return { added: [...new Set([...added, ...rosterAdded, ...docsAdded])].sort(), removed };
}
