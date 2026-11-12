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
import {
  configOwners,
  configSourceDirs,
  designVariantOfSession,
  type SessionConfig,
  sessionConfigOf,
} from '../ingest/session-config.js';
import { publishStageChanges, updateStages } from '../stages/report.js';
import { HttpError } from '../variants/errors.js';
import type { Variants } from '../variants/index.js';
import { dataLayout } from '../variants/layout.js';
import { displayName } from '../variants/names.js';

// Contracts 15.1: binding sessions to variants

type Variant = typeof variantsTable.$inferSelect;
type SkillLoad = typeof sessionSkills.$inferSelect;

export const SKILL_PREFIX = /^Base directory for this skill: (.+)\n\n/;

// Claude Code's bundled skills (unpacked to <TMPDIR>/claude-<uid>/bundled-skills/<version>/…) belong to no variant and are not compared
export const isBundledSkill = (baseDir: string) => baseDir.split('/').includes('bundled-skills');

// gray-matter only splits frontmatter from body and does not parse YAML: the frontmatter of a SKILL.md being edited may
// briefly be invalid YAML, and comparing and deriving need only the body
const splitFrontmatter = (file: string) => matter(file, { engines: { yaml: () => ({}) } });

// SKILL.md file → body written into the session on load: drop the frontmatter and the one newline after it
export function skillFileBody(file: string): string {
  return splitFrontmatter(file).content.replace(/^\n/, '');
}

// Rendering on load: with arguments, replace $ARGUMENTS if the body has it, otherwise append an ARGUMENTS line
export function renderSkill(body: string, args: string): string {
  if (args === '') return body;
  if (body.includes('$ARGUMENTS')) return body.replaceAll('$ARGUMENTS', args);
  return `${body}\n\nARGUMENTS: ${args}`;
}

// Restore the body from the session text; impossible when the arguments were substituted into the body ($ARGUMENTS)
export function loadBody(load: Pick<SkillLoad, 'name' | 'text' | 'args'>): string {
  if (load.args === '') return load.text;
  const suffix = `\n\nARGUMENTS: ${load.args}`;
  if (!load.text.endsWith(suffix)) {
    throw new HttpError(
      409,
      `Arguments were substituted into the body of skill ${load.name} ($ARGUMENTS), so the SKILL.md body cannot be restored`,
    );
  }
  return load.text.slice(0, -suffix.length);
}

// Skill loads to compare (excluding Claude Code's bundled ones), in time order
export function sessionSkillLoads(db: Db, sessionId: string): SkillLoad[] {
  return db
    .select()
    .from(sessionSkills)
    .where(eq(sessionSkills.sessionId, sessionId))
    .orderBy(asc(sessionSkills.timestamp), asc(sessionSkills.id))
    .all()
    .filter((l) => !isBundledSkill(l.baseDir));
}

// A variant's src/skills/<name>/SKILL.md (directory data/variants/<storage_id or id>); cached per comparison, each file read once
function skillFileReader(dataDir: string) {
  const layout = dataLayout(dataDir);
  const cache = new Map<string, string | null>();
  return (variant: Pick<Variant, 'id' | 'storageId'>, name: string): string | null => {
    const file = path.join(
      layout.variant(variant.storageId ?? variant.id).skills,
      name,
      'SKILL.md',
    );
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
  read: (variant: Variant, name: string) => string | null,
): boolean {
  return loads.every((load) => {
    const body = read(variant, load.name);
    return body !== null && renderSkill(body, load.args) === load.text;
  });
}

// Variants that match every skill the session loaded byte for byte, oldest first; empty when no skill was loaded
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
    .where(isNull(variantsTable.deletedAt))
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
  // The bound variant decides the workflow used for stage partitioning (Contracts 16.6): recompute from scratch when it changes
  publishStageChanges(sessionId, updateStages(db, sessionId));
}

function configOfSession(db: Db, sessionId: string): SessionConfig | null {
  const row = db
    .select({ engine: sessions.engine, filePath: sessions.filePath })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  if (row === undefined) throw new HttpError(404, `Session ${sessionId} does not exist`);
  return sessionConfigOf(configSourceDirs, row.engine, row.filePath);
}

// Sessions of the local-machine config are not bound to a variant (Contracts 25.4)
const localSession = (db: Db, sessionId: string) => configOfSession(db, sessionId)?.id === 'local';

const LOCAL_NO_BINDING =
  'Sessions of the local-machine config are not bound to a variant: binding applies only to sessions under a variant config or design and optimize';

// Re-decide a session's automatic binding: run and manual bindings stay; local-machine sessions are not bound; a session under a
// variant config is bound to the variant owning that config directory (Contracts 25.4; for a shared directory, the current one,
// else the one matching the skills, else the oldest); otherwise keep the auto-bound variant while it still matches, else bind
// the oldest matching variant, or unbind when none
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
  if (row === undefined) throw new Error(`Session ${sessionId} does not exist`);
  if (row.binding === 'run' || row.binding === 'manual') return;
  const c = configOfSession(db, sessionId);
  if (c?.id === 'local') {
    if (row.variantId !== null || row.binding !== null) setBinding(db, sessionId, null, null);
    return;
  }
  // Design session sessions bind to the workflow-design / workflow-optimize variant they use (Contracts 33.3)
  if (c?.id === 'design') {
    const designVariantId = designVariantOfSession(db, sessionId);
    if (designVariantId !== null && (designVariantId !== row.variantId || row.binding !== 'auto'))
      setBinding(db, sessionId, designVariantId, 'auto');
    return;
  }
  const owners = c?.id === 'variant' ? configOwners(db, c.storageId) : [];
  const found = owners.length === 1 ? [] : matchingVariants(db, dataDir, sessionId, read);
  const candidates =
    owners.length === 0
      ? found
      : [...owners.filter((o) => found.some((f) => f.id === o.id)), ...owners];
  const keep = candidates.find((v) => v.id === row.variantId);
  const next = keep ?? candidates[0] ?? null;
  const variantId = next?.id ?? null;
  if (variantId === row.variantId && (variantId === null) === (row.binding === null)) return;
  setBinding(db, sessionId, variantId, next === null ? null : 'auto');
}

// After a variant is created or skill content changes, re-decide every session that can be auto-bound (a session under a
// variant config is bound to its owning variant even without skill loads)
export function rebindAll(db: Db, dataDir: string): void {
  const read = skillFileReader(dataDir);
  const candidates = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(or(isNull(sessions.variantBinding), eq(sessions.variantBinding, 'auto')))
    .all();
  for (const { id } of candidates) rebindSession(db, dataDir, id, read);
}

// A run's sessions bind to the run's variant; run sessions imported before this table existed are filled in at startup
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

// Called by the Live module when a Live session (live_sessions.variant_id, Contracts 14.1) is imported: bind it to its variant;
// with no variantId (local-machine config) no variant is bound and the imported skills decide automatically
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
  // deleted: the bound variant was deleted (a run's sessions stay with the run, Contracts 24.3); its variant page cannot be opened
  variant: { id: string; name: string; deleted: boolean } | null;
  binding: VariantBinding | null;
  // Every variant matching the session's skills (including the bound one), by creation time
  matching: { id: string; name: string }[];
  // Compared skills (deduplicated, in order of first load) and their load counts
  skills: { name: string; loads: number }[];
}

export function bindingView(db: Db, dataDir: string, sessionId: string): BindingView {
  const row = db
    .select({ variantId: sessions.variantId, binding: sessions.variantBinding })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  if (row === undefined) throw new HttpError(404, `Session ${sessionId} does not exist`);
  const variant =
    row.variantId === null ? undefined : boundVariantNames(db, [row.variantId]).get(row.variantId);
  const skills: { name: string; loads: number }[] = [];
  for (const load of sessionSkillLoads(db, sessionId)) {
    const entry = skills.find((s) => s.name === load.name);
    if (entry === undefined) skills.push({ name: load.name, loads: 1 });
    else entry.loads += 1;
  }
  return {
    variant:
      row.variantId === null || variant === undefined ? null : { id: row.variantId, ...variant },
    binding: row.binding,
    // Local-machine sessions are not bound and list no matching variants (Contracts 25.4)
    matching: localSession(db, sessionId)
      ? []
      : matchingVariants(db, dataDir, sessionId).map((v) => ({ id: v.id, name: v.name })),
    skills,
  };
}

// For lists: display names of the variants a batch of sessions is bound to (a deleted one shows as "<name> (deleted)", Contracts 24.3) and whether deleted
export function boundVariantNames(
  db: Db,
  variantIds: string[],
): Map<string, { name: string; deleted: boolean }> {
  if (variantIds.length === 0) return new Map();
  return new Map(
    db
      .select({
        id: variantsTable.id,
        name: variantsTable.name,
        deletedAt: variantsTable.deletedAt,
      })
      .from(variantsTable)
      .where(inArray(variantsTable.id, variantIds))
      .all()
      .map((v) => [v.id, { name: displayName(v), deleted: v.deletedAt !== null }]),
  );
}

// Manual choice (a null variantId unbinds), or back to automatic
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
  if (exists === undefined) throw new HttpError(404, `Session ${sessionId} does not exist`);
  if (exists.binding === 'run') {
    throw new HttpError(
      409,
      `Session ${sessionId} belongs to a run or Live and is bound to the variant it uses`,
    );
  }
  if (localSession(db, sessionId)) throw new HttpError(409, LOCAL_NO_BINDING);
  if (choice === 'auto') {
    setBinding(db, sessionId, null, null);
    rebindSession(db, dataDir, sessionId);
    return;
  }
  if (choice.variantId !== null) {
    const v = db
      .select({
        id: variantsTable.id,
        name: variantsTable.name,
        deletedAt: variantsTable.deletedAt,
      })
      .from(variantsTable)
      .where(eq(variantsTable.id, choice.variantId))
      .get();
    if (v === undefined) throw new HttpError(404, `Variant does not exist: ${choice.variantId}`);
    if (v.deletedAt !== null) throw new HttpError(404, `Variant ${v.name} was deleted`);
  }
  setBinding(db, sessionId, choice.variantId, 'manual');
}

// The default base: the oldest baseline (no parent, has an install directory); without a baseline, the oldest variant
export function defaultBaseVariant(db: Db): Variant | null {
  const all = db
    .select()
    .from(variantsTable)
    .where(isNull(variantsTable.deletedAt))
    .orderBy(asc(variantsTable.createdAt), asc(variantsTable.id))
    .all();
  return all.find((v) => v.parentId === null && v.installDir !== null) ?? all[0] ?? null;
}

// "New variant from this session's skills": derive a draft from the base and replace the SKILL.md body of every skill the session
// loaded with the session's body; frontmatter and other files in the skill directory come from the base; record the source session and auto-bind it
export function deriveFromSession(
  db: Db,
  variants: Variants,
  dataDir: string,
  sessionId: string,
  input: { baseVariantId: string; name: string },
): Variant {
  const loads = sessionSkillLoads(db, sessionId);
  if (localSession(db, sessionId)) throw new HttpError(409, LOCAL_NO_BINDING);
  if (loads.length === 0) throw new HttpError(409, `Session ${sessionId} loaded no skill`);
  const bodies = new Map<string, string>();
  for (const load of loads) {
    const body = loadBody(load);
    const seen = bodies.get(load.name);
    if (seen !== undefined && seen !== body) {
      throw new HttpError(
        409,
        `Skill ${load.name} was loaded with two different bodies in the session`,
      );
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
        `Base variant ${base.name} has no skill ${name}, so its frontmatter is unavailable`,
      );
    }
    const original = fs.readFileSync(absolute, 'utf8');
    const content = splitFrontmatter(original).content;
    if (!original.endsWith(content))
      throw new Error(`The body of ${absolute} is not the end of the file`);
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
    throw new Error(
      `New variant ${created.name} does not match the skills of session ${sessionId}`,
    );
  }
  const row = db
    .select({ binding: sessions.variantBinding })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  if (row?.binding !== 'run') setBinding(db, sessionId, created.id, 'auto');
  return variants.get(created.id);
}
