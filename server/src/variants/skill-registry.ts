import fs from 'node:fs';
import path from 'node:path';
import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from 'yaml';

// A new workflow's variant adds and removes skill directories (Contracts 16.4): wf guard requires every skill in src/skills to be
// registered in workflow/registry.yaml components and the docs/index.yaml skills roster, with a feature record and its docs entry.
// Before a build, new skills are registered in the format of an existing skill entry and skills whose directory is gone are removed; no file changes without additions or removals.
// Entry positions come from the ranges of the yaml Document; only whole entries are inserted or removed there, everything else stays byte for byte

const REGISTRY = 'workflow/registry.yaml';
const ROSTER = 'docs/index.yaml';
const FEATURES = 'docs/product/features';
export const REGISTRY_FILES = [REGISTRY, ROSTER, FEATURES];

export interface SkillRegistration {
  added: string[];
  removed: string[];
}

// Directories under src/skills that have a SKILL.md
function skillDirs(srcDir: string): string[] {
  const dir = path.join(srcDir, 'skills');
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort();
}

// The items of a block list in a YAML file, each with its whole-line range in the text (from the start of its "- " line to before the next item)
interface Item {
  map: YAMLMap;
  start: number;
  end: number;
}

function listItems(text: string, key: string, file: string): Item[] {
  const doc = parseDocument(text);
  if (doc.errors.length > 0)
    throw new Error(`${file} is not valid YAML: ${doc.errors[0]?.message ?? ''}`);
  const seq = doc.get(key, true);
  if (!isSeq(seq)) throw new Error(`${key} in ${file} is not a list`);
  return seq.items.map((item) => {
    if (!isMap(item) || item.range == null)
      throw new Error(`${key} in ${file} has an item that is not a map`);
    const start = text.lastIndexOf('\n', item.range[0]) + 1;
    // To the end of the line of the item's last value (with the newline); blank lines and comments between items go to the next item
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

// Uses the template item's text as the format, replacing its field values with new ones (each value occurs once in the item)
function cloneText(text: string, template: Item, replace: [string, string][]): string {
  let out = text.slice(template.start, template.end);
  for (const [from, to] of replace) {
    if (out.split(from).length !== 2)
      throw new Error(`${from} does not occur exactly once in the template entry`);
    out = out.replace(from, to);
  }
  return out;
}

// A registry skill entry: kind skill, source skills/<name>
const registryName = (map: YAMLMap) => {
  const source = str(map, 'source');
  return str(map, 'kind') === 'skill' && source?.startsWith('skills/') === true
    ? source.slice('skills/'.length)
    : null;
};

// Shipped skills in the roster
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
    throw new Error(`${registryFile} has no skill entry to use as a template`);
  }
  const templateName = registryName(template.map) ?? '';
  const registeredNames = registered.map((c) => registryName(c.map));
  const added = dirs.filter((d) => !registeredNames.includes(d));
  const removedRegistry = registered.filter((c) => !dirs.includes(registryName(c.map) ?? ''));
  const registrySplices: Splice[] = [
    // New entries go after the last skill entry
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
    throw new Error(`skills in ${rosterFile} has no shipped skill to use as a template`);
  }
  const shippedNames = shipped.map((r) => rosterName(r.map));
  const rosterAdded = dirs.filter((d) => !shippedNames.includes(d));
  const removedRows = shipped.filter((r) => !dirs.includes(rosterName(r.map) ?? ''));
  // A roster row: name and invocation become the new skill, note states the origin (note may be multi-line folded text, replaced whole)
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
    return `${replaced}\n${indent}note: Skill ${name} registered by wf-dashboard for a variant.\n`;
  };

  const docs = listItems(rosterText, 'docs', rosterFile);
  const docTemplate = docs.find((d) => str(d.map, 'path') === featurePath(templateName));
  if (docTemplate === undefined) {
    throw new Error(
      `docs in ${rosterFile} has no ${featurePath(templateName)} to use as a template`,
    );
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
      `---\nlast-verified: ${new Date().toISOString().slice(0, 10)}\n---\n\n# /${name}\n\n**Status:** shipped · **Skill:** [\`skills/${name}/SKILL.md\`](../../../skills/${name}/SKILL.md)\n\nSkill ${name} registered by wf-dashboard for a variant.\n`,
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
