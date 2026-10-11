import fs from 'node:fs';
import path from 'node:path';
import { asc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import matter from 'gray-matter';
import type { Db } from '../db/index.js';
import {
  runs,
  sessions,
  sessionSkills,
  type VariantBinding,
  variants as variantsTable,
} from '../db/schema.js';
import { events } from '../events.js';
import { HttpError } from '../variants/errors.js';
import type { Variants } from '../variants/index.js';
import { dataLayout } from '../variants/layout.js';

// Contracts 15.1：session 绑定 variant

type Variant = typeof variantsTable.$inferSelect;
type SkillLoad = typeof sessionSkills.$inferSelect;

export const SKILL_PREFIX = /^Base directory for this skill: (.+)\n\n/;

// Claude Code 自带的 skill（解压到 <TMPDIR>/claude-<uid>/bundled-skills/<版本>/…）不属于任何 variant，不参与比较
export const isBundledSkill = (baseDir: string) => baseDir.split('/').includes('bundled-skills');

// gray-matter 只用来切分 frontmatter 与正文，不解析 YAML：正在编辑的 SKILL.md 的 frontmatter 可能暂时不是合法的 YAML，
// 比较与派生只需要正文
const splitFrontmatter = (file: string) => matter(file, { engines: { yaml: () => ({}) } });

// SKILL.md 文件 → 加载时写入 session 的正文：去掉 frontmatter 与紧随其后的一个换行
export function skillFileBody(file: string): string {
  return splitFrontmatter(file).content.replace(/^\n/, '');
}

// 加载时的渲染：有参数时，正文含 $ARGUMENTS 则替换，否则末尾加 ARGUMENTS 行
export function renderSkill(body: string, args: string): string {
  if (args === '') return body;
  if (body.includes('$ARGUMENTS')) return body.replaceAll('$ARGUMENTS', args);
  return `${body}\n\nARGUMENTS: ${args}`;
}

// 由 session 中的原文还原正文；参数被替换进正文（$ARGUMENTS）时无法还原
export function loadBody(load: Pick<SkillLoad, 'name' | 'text' | 'args'>): string {
  if (load.args === '') return load.text;
  const suffix = `\n\nARGUMENTS: ${load.args}`;
  if (!load.text.endsWith(suffix)) {
    throw new HttpError(
      409,
      `skill ${load.name} 的正文中参数已被替换（$ARGUMENTS），无法还原 SKILL.md 的正文`,
    );
  }
  return load.text.slice(0, -suffix.length);
}

// 参与比较的 skill 加载（不含 Claude Code 自带的），按时间排序
export function sessionSkillLoads(db: Db, sessionId: string): SkillLoad[] {
  return db
    .select()
    .from(sessionSkills)
    .where(eq(sessionSkills.sessionId, sessionId))
    .orderBy(asc(sessionSkills.timestamp), asc(sessionSkills.id))
    .all()
    .filter((l) => !isBundledSkill(l.baseDir));
}

// variant 的 src/skills/<name>/SKILL.md；一次比较中缓存，同一文件只读一次
function skillFileReader(dataDir: string) {
  const layout = dataLayout(dataDir);
  const cache = new Map<string, string | null>();
  return (variantId: string, name: string): string | null => {
    const file = path.join(layout.variant(variantId).skills, name, 'SKILL.md');
    let content = cache.get(file);
    if (content === undefined) {
      content = fs.existsSync(file) ? skillFileBody(fs.readFileSync(file, 'utf8')) : null;
      cache.set(file, content);
    }
    return content;
  };
}

function matches(
  loads: SkillLoad[],
  variant: Variant,
  read: (variantId: string, name: string) => string | null,
): boolean {
  return loads.every((load) => {
    const body = read(variant.id, load.name);
    return body !== null && renderSkill(body, load.args) === load.text;
  });
}

// session 加载过的全部 skill 都与其逐字节一致的 variant，按创建时间从早到晚；没有 skill 加载时为空
export function matchingVariants(
  db: Db,
  dataDir: string,
  sessionId: string,
  read = skillFileReader(dataDir),
): Variant[] {
  const loads = sessionSkillLoads(db, sessionId);
  if (loads.length === 0) return [];
  const all = db
    .select()
    .from(variantsTable)
    .orderBy(asc(variantsTable.createdAt), asc(variantsTable.id))
    .all();
  return all.filter((v) => matches(loads, v, read));
}

function setBinding(
  db: Db,
  sessionId: string,
  variantId: string | null,
  binding: VariantBinding | null,
) {
  db.update(sessions)
    .set({ variantId, variantBinding: binding })
    .where(eq(sessions.id, sessionId))
    .run();
  events.publish({ type: 'session.updated', sessionId });
}

// 重新判定一个 session 的自动绑定：run 与手动的绑定不动；当前自动绑定的 variant 仍一致时保留，
// 否则绑定一致的 variant 中最早创建的，没有时解除
export function rebindSession(
  db: Db,
  dataDir: string,
  sessionId: string,
  read = skillFileReader(dataDir),
): void {
  const row = db
    .select({ variantId: sessions.variantId, binding: sessions.variantBinding })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  if (row === undefined) throw new Error(`session ${sessionId} 不存在`);
  if (row.binding === 'run' || row.binding === 'manual') return;
  const found = matchingVariants(db, dataDir, sessionId, read);
  const keep = found.find((v) => v.id === row.variantId);
  const next = keep ?? found[0] ?? null;
  const variantId = next?.id ?? null;
  if (variantId === row.variantId && (variantId === null) === (row.binding === null)) return;
  setBinding(db, sessionId, variantId, next === null ? null : 'auto');
}

// variant 新建或 skill 内容变化后，重新判定全部可以自动绑定的 session
export function rebindAll(db: Db, dataDir: string): void {
  const read = skillFileReader(dataDir);
  const candidates = db
    .selectDistinct({ id: sessionSkills.sessionId })
    .from(sessionSkills)
    .innerJoin(sessions, eq(sessions.id, sessionSkills.sessionId))
    .where(or(isNull(sessions.variantBinding), eq(sessions.variantBinding, 'auto')))
    .all();
  for (const { id } of candidates) rebindSession(db, dataDir, id, read);
}

// run 的 session 绑定 run 所用的 variant；本表出现之前导入的 run session 在启动时补上
export function bindRunSessions(db: Db): void {
  const rows = db
    .select({ id: sessions.id, variantId: runs.variantId, binding: sessions.variantBinding })
    .from(sessions)
    .innerJoin(runs, eq(runs.id, sessions.runId))
    .where(isNotNull(sessions.runId))
    .all();
  for (const r of rows) {
    if (r.binding === 'run') continue;
    setBinding(db, r.id, r.variantId, 'run');
  }
}

// 交互的 session（Contracts 14.1 的 live_sessions.variant_id）导入时由交互模块调用：绑定它所用的 variant；
// variantId 为空（本机配置）时不绑定 variant，仍按导入的 skill 自动判定
export function bindLiveSession(
  db: Db,
  dataDir: string,
  sessionId: string,
  variantId: string | null,
) {
  if (variantId === null) {
    rebindSession(db, dataDir, sessionId);
    return;
  }
  setBinding(db, sessionId, variantId, 'run');
}

export interface BindingView {
  variant: { id: string; name: string } | null;
  binding: VariantBinding | null;
  // 与 session 的 skill 一致的全部 variant（含已绑定的），按创建时间
  matching: { id: string; name: string }[];
  // 参与比较的 skill（去重，按首次加载的顺序）与加载次数
  skills: { name: string; loads: number }[];
}

export function bindingView(db: Db, dataDir: string, sessionId: string): BindingView {
  const row = db
    .select({ variantId: sessions.variantId, binding: sessions.variantBinding })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  if (row === undefined) throw new HttpError(404, `session ${sessionId} 不存在`);
  const variant =
    row.variantId === null
      ? undefined
      : db
          .select({ id: variantsTable.id, name: variantsTable.name })
          .from(variantsTable)
          .where(eq(variantsTable.id, row.variantId))
          .get();
  const skills: { name: string; loads: number }[] = [];
  for (const load of sessionSkillLoads(db, sessionId)) {
    const entry = skills.find((s) => s.name === load.name);
    if (entry === undefined) skills.push({ name: load.name, loads: 1 });
    else entry.loads += 1;
  }
  return {
    variant: variant ?? null,
    binding: row.binding,
    matching: matchingVariants(db, dataDir, sessionId).map((v) => ({ id: v.id, name: v.name })),
    skills,
  };
}

// 列表用：一批 session 绑定的 variant 名称
export function boundVariantNames(db: Db, variantIds: string[]): Map<string, string> {
  if (variantIds.length === 0) return new Map();
  return new Map(
    db
      .select({ id: variantsTable.id, name: variantsTable.name })
      .from(variantsTable)
      .where(inArray(variantsTable.id, variantIds))
      .all()
      .map((v) => [v.id, v.name]),
  );
}

// 手动改选（variantId 为空表示解除），或恢复自动判定
export function setManualBinding(
  db: Db,
  dataDir: string,
  sessionId: string,
  choice: { variantId: string | null } | 'auto',
) {
  const exists = db
    .select({ id: sessions.id, binding: sessions.variantBinding })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  if (exists === undefined) throw new HttpError(404, `session ${sessionId} 不存在`);
  if (exists.binding === 'run') {
    throw new HttpError(409, `session ${sessionId} 属于 run 或交互，绑定的是它所用的 variant`);
  }
  if (choice === 'auto') {
    setBinding(db, sessionId, null, null);
    rebindSession(db, dataDir, sessionId);
    return;
  }
  if (choice.variantId !== null) {
    const v = db
      .select({ id: variantsTable.id })
      .from(variantsTable)
      .where(eq(variantsTable.id, choice.variantId))
      .get();
    if (v === undefined) throw new HttpError(404, `variant 不存在：${choice.variantId}`);
  }
  setBinding(db, sessionId, choice.variantId, 'manual');
}

// 默认的底子：最早创建的基线（没有 parent、有安装目录）；没有基线时取最早的 variant
export function defaultBaseVariant(db: Db): Variant | null {
  const all = db
    .select()
    .from(variantsTable)
    .orderBy(asc(variantsTable.createdAt), asc(variantsTable.id))
    .all();
  return all.find((v) => v.parentId === null && v.installDir !== null) ?? all[0] ?? null;
}

// "按这个 session 的 skill 新建 variant"：从底子派生草稿，把 session 加载过的每个 skill 的 SKILL.md 正文换成 session 中的正文，
// frontmatter 与同一 skill 目录中的其他文件来自底子；记录来源 session，并自动绑定这个 session
export function deriveFromSession(
  db: Db,
  variants: Variants,
  dataDir: string,
  sessionId: string,
  input: { baseVariantId: string; name: string },
): Variant {
  const loads = sessionSkillLoads(db, sessionId);
  if (loads.length === 0) throw new HttpError(409, `session ${sessionId} 没有加载过 skill`);
  const bodies = new Map<string, string>();
  for (const load of loads) {
    const body = loadBody(load);
    const seen = bodies.get(load.name);
    if (seen !== undefined && seen !== body) {
      throw new HttpError(409, `skill ${load.name} 在 session 中加载过两种不同的正文`);
    }
    bodies.set(load.name, body);
  }
  const base = variants.get(input.baseVariantId);
  const files = [...bodies].map(([name, body]) => {
    const relative = `skills/${name}/SKILL.md`;
    const absolute = path.join(variants.layout(base.id).src, relative);
    if (!fs.existsSync(absolute)) {
      throw new HttpError(
        409,
        `底子 variant ${base.name} 中没有 skill ${name}，取不到它的 frontmatter`,
      );
    }
    const original = fs.readFileSync(absolute, 'utf8');
    const content = splitFrontmatter(original).content;
    if (!original.endsWith(content)) throw new Error(`${absolute} 的正文不是文件的结尾部分`);
    const front = original.slice(0, original.length - content.length);
    return { relative, content: `${front}\n${body}` };
  });
  const created = variants.derive(base.id, { name: input.name });
  for (const f of files) variants.writeFile(created.id, f.relative, f.content);
  db.update(variantsTable)
    .set({ sourceSessionId: sessionId })
    .where(eq(variantsTable.id, created.id))
    .run();
  const read = skillFileReader(dataDir);
  if (!matches(loads, variants.get(created.id), read)) {
    throw new Error(`新建的 variant ${created.name} 与 session ${sessionId} 的 skill 不一致`);
  }
  const row = db
    .select({ binding: sessions.variantBinding })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  if (row?.binding !== 'run') setBinding(db, sessionId, created.id, 'auto');
  return variants.get(created.id);
}
