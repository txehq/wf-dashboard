import fs from 'node:fs';
import path from 'node:path';
import { diffArrays, parsePatch } from 'diff';
import { execa } from 'execa';
import { z } from 'zod';
import { type AnalysisAspect, type FindingEvidence, findingSeverities } from '../db/schema.js';
import type { ExportedRow } from './export.js';

// Contracts 15.2：引擎输出文件的格式与 dashboard 的校验；不满足时以原文失败

const Evidence = z.object({
  sessionId: z.string().min(1),
  seq: z.int().min(0),
  quote: z.string().min(1),
});

export const EngineFinding = z.object({
  title: z.string().trim().min(1),
  stage: z.string().trim().min(1).nullable(),
  skill: z.string().trim().min(1).nullable(),
  severity: z.enum(findingSeverities),
  detail: z.string().trim().min(1),
  evidence: z.array(Evidence).min(1),
});
export type EngineFinding = z.infer<typeof EngineFinding>;

export interface ValidatedFinding extends EngineFinding {
  findingId: string;
  aspect: AnalysisAspect;
  evidence: FindingEvidence[];
}

export const findingsFile = (aspect: AnalysisAspect) => `findings-${aspect}.json`;

function readJson(file: string): unknown {
  if (!fs.existsSync(file)) throw new Error(`引擎没有写出 ${file}`);
  const text = fs.readFileSync(file, 'utf8');
  return JSON.parse(text);
}

// 一行导出内容中的全部字符串值（递归），quote 必须是其中某一个的子串
function strings(value: unknown, out: string[]) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (typeof value === 'object' && value !== null)
    for (const v of Object.values(value)) strings(v, out);
}

// 每个 session 中每个主 agent seq 可以引用的内容：该行与 parentSeq 指向它的子代理行
export type EvidenceIndex = Map<string, Map<number, string[]>>;

export function evidenceIndex(exported: Map<string, ExportedRow[]>): EvidenceIndex {
  const index: EvidenceIndex = new Map();
  for (const [sessionId, rows] of exported) {
    const bySeq = new Map<number, string[]>();
    for (const r of rows) if (r.agent === null) bySeq.set(r.seq, []);
    for (const r of rows) {
      const list = bySeq.get(r.parentSeq);
      if (list === undefined)
        throw new Error(
          `session ${sessionId} 中子代理行的 parentSeq ${String(r.parentSeq)} 不存在`,
        );
      strings(r, list);
    }
    index.set(sessionId, bySeq);
  }
  return index;
}

// 校验一个方面的输出：zod 格式，以及每条证据的 seq 存在、quote 是该行导出内容的子串
export function validateFindings(
  file: string,
  aspect: AnalysisAspect,
  index: EvidenceIndex,
): ValidatedFinding[] {
  const parsed = z.array(EngineFinding).safeParse(readJson(file));
  if (!parsed.success) {
    throw new Error(`${path.basename(file)} 的格式不对：${z.prettifyError(parsed.error)}`);
  }
  const problems: string[] = [];
  const findings = parsed.data.map((f, i): ValidatedFinding => {
    for (const e of f.evidence) {
      const where = `第 ${String(i + 1)} 条发现「${f.title}」的证据 ${e.sessionId}#${String(e.seq)}`;
      const session = index.get(e.sessionId);
      if (session === undefined) {
        problems.push(`${where}：session 不在这次分析的范围内`);
        continue;
      }
      const texts = session.get(e.seq);
      if (texts === undefined) {
        problems.push(`${where}：主 agent 中没有 seq ${String(e.seq)}`);
        continue;
      }
      if (!texts.some((t) => t.includes(e.quote))) {
        problems.push(`${where}：quote 不是该行导出内容的子串：${JSON.stringify(e.quote)}`);
      }
    }
    return { ...f, findingId: `${aspect}-${String(i + 1)}`, aspect };
  });
  if (problems.length > 0) {
    throw new Error(`${path.basename(file)} 的证据校验失败：\n${problems.join('\n')}`);
  }
  return findings;
}

// 把带 id 的发现写回输出目录，供综合步骤引用
export function writeFindingsWithIds(file: string, findings: ValidatedFinding[]) {
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      findings.map((f) => ({
        id: f.findingId,
        title: f.title,
        stage: f.stage,
        skill: f.skill,
        severity: f.severity,
        detail: f.detail,
        evidence: f.evidence,
      })),
      null,
      2,
    )}\n`,
  );
}

export const EnginePatch = z.object({
  file: z.string().trim().min(1),
  findingIds: z.array(z.string().min(1)).min(1),
  rationale: z.string().trim().min(1),
  patch: z.string().min(1),
});
export type EnginePatch = z.infer<typeof EnginePatch>;

// 一处改动：在原文第 start 行（0 起）删除 remove，插入 insert；行含换行符
export interface Hunk {
  index: number;
  start: number;
  remove: string[];
  insert: string[];
  findingIds: string[];
}

export interface FileProposal {
  // 相对 src/ 的路径，例如 skills/ic/SKILL.md
  path: string;
  original: string;
  proposed: string;
  hunks: Hunk[];
}

const splitLines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

// 原文与修改后之间的改动，相邻的删除与插入合为一处
export function hunksOf(original: string, proposed: string): Omit<Hunk, 'index' | 'findingIds'>[] {
  const hunks: Omit<Hunk, 'index' | 'findingIds'>[] = [];
  let line = 0;
  let current: Omit<Hunk, 'index' | 'findingIds'> | null = null;
  for (const change of diffArrays(splitLines(original), splitLines(proposed))) {
    if (!change.added && !change.removed) {
      if (current !== null) hunks.push(current);
      current = null;
      line += change.count;
      continue;
    }
    current ??= { start: line, remove: [], insert: [] };
    if (change.removed) {
      current.remove.push(...change.value);
      line += change.count;
    } else current.insert.push(...change.value);
  }
  if (current !== null) hunks.push(current);
  return hunks;
}

// 按选择的改动生成结果（页面同样的算法）
export function applyHunks(original: string, hunks: Omit<Hunk, 'index' | 'findingIds'>[]): string {
  const lines = splitLines(original);
  const out: string[] = [];
  let line = 0;
  for (const h of [...hunks].sort((a, b) => a.start - b.start)) {
    out.push(...lines.slice(line, h.start), ...h.insert);
    line = h.start + h.remove.length;
  }
  out.push(...lines.slice(line));
  return out.join('');
}

// 分析目录内的 git 操作不能落到包含它的 dashboard 仓库：GIT_CEILING_DIRECTORIES 阻止向上查找仓库
async function gitApply(cwd: string, ceiling: string, args: string[]) {
  return execa('git', ['apply', ...args], {
    cwd,
    reject: false,
    env: { GIT_CEILING_DIRECTORIES: ceiling },
  });
}

const stripPrefix = (name: string | undefined) =>
  name === undefined || name === '/dev/null' ? null : name.replace(/^[ab]\//, '');

// 校验 patches.json：格式、findingIds 存在、每个 patch 只改 file 一个文件且不删除文件、
// 在 input/skills 的副本上 git apply --check -p1；之后按顺序全部应用，得到每个文件的修改结果与逐处改动
export async function validatePatches(
  file: string,
  skillsDir: string,
  workDir: string,
  findingIds: Set<string>,
): Promise<{ patches: EnginePatch[]; files: FileProposal[] }> {
  const parsed = z.array(EnginePatch).safeParse(readJson(file));
  if (!parsed.success) {
    throw new Error(`patches.json 的格式不对：${z.prettifyError(parsed.error)}`);
  }
  const patches = parsed.data;
  fs.rmSync(workDir, { recursive: true, force: true });
  const original = path.join(workDir, 'original');
  const proposed = path.join(workDir, 'proposed');
  fs.cpSync(skillsDir, original, { recursive: true });
  fs.cpSync(skillsDir, proposed, { recursive: true });
  const problems: string[] = [];
  const perPatchRanges: {
    file: string;
    ids: string[];
    changed: { start: number; end: number }[];
  }[] = [];
  for (const [i, p] of patches.entries()) {
    const where = `第 ${String(i + 1)} 个 patch（${p.file}）`;
    const unknown = p.findingIds.filter((id) => !findingIds.has(id));
    if (unknown.length > 0) problems.push(`${where}：findingIds 不存在：${unknown.join(', ')}`);
    const parts = parsePatch(p.patch);
    const targets = parts.map((d) => ({
      old: stripPrefix(d.oldFileName),
      new: stripPrefix(d.newFileName),
    }));
    if (targets.length !== 1 || targets[0]?.new !== p.file) {
      problems.push(`${where}：patch 必须只修改 ${p.file}，实际为 ${JSON.stringify(targets)}`);
      continue;
    }
    if (targets[0].old !== null && targets[0].old !== p.file) {
      problems.push(`${where}：patch 的原文件是 ${targets[0].old}，与 file 不同`);
      continue;
    }
    const patchFile = path.join(workDir, `patch-${String(i + 1)}.diff`);
    fs.writeFileSync(patchFile, p.patch.endsWith('\n') ? p.patch : `${p.patch}\n`);
    const check = await gitApply(original, workDir, ['--check', '-p1', patchFile]);
    if (check.exitCode !== 0) {
      problems.push(`${where}：git apply --check 失败：${check.stderr.trim()}`);
      continue;
    }
    // 单独应用到一份只含该文件的副本，得到它在原文中改动的行
    const single = path.join(workDir, `single-${String(i + 1)}`);
    const before = path.join(original, p.file);
    const beforeText = fs.existsSync(before) ? fs.readFileSync(before, 'utf8') : '';
    fs.mkdirSync(path.dirname(path.join(single, p.file)), { recursive: true });
    if (fs.existsSync(before)) fs.copyFileSync(before, path.join(single, p.file));
    const alone = await gitApply(single, workDir, ['-p1', patchFile]);
    if (alone.exitCode !== 0) throw new Error(`${where}：单独应用失败：${alone.stderr.trim()}`);
    const afterText = fs.readFileSync(path.join(single, p.file), 'utf8');
    perPatchRanges.push({
      file: p.file,
      ids: p.findingIds,
      changed: hunksOf(beforeText, afterText).map((h) => ({
        start: h.start,
        end: h.start + h.remove.length,
      })),
    });
  }
  if (problems.length > 0) throw new Error(`patches.json 校验失败：\n${problems.join('\n')}`);

  for (const [i, p] of patches.entries()) {
    const applied = await gitApply(proposed, workDir, [
      '-p1',
      path.join(workDir, `patch-${String(i + 1)}.diff`),
    ]);
    if (applied.exitCode !== 0) {
      throw new Error(
        `第 ${String(i + 1)} 个 patch（${p.file}）与之前的 patch 修改了重叠的内容，依次应用失败：${applied.stderr.trim()}`,
      );
    }
  }

  const files: FileProposal[] = [...new Set(patches.map((p) => p.file))].sort().map((f) => {
    const before = path.join(original, f);
    const originalText = fs.existsSync(before) ? fs.readFileSync(before, 'utf8') : '';
    const proposedText = fs.readFileSync(path.join(proposed, f), 'utf8');
    const ranges = perPatchRanges.filter((r) => r.file === f);
    const hunks = hunksOf(originalText, proposedText).map((h, index): Hunk => {
      const end = h.start + h.remove.length;
      // 与这处改动重叠或相接的单个 patch 的改动，即它对应的发现
      const ids = ranges
        .filter((r) => r.changed.some((c) => c.start <= end && h.start <= c.end))
        .flatMap((r) => r.ids);
      return { ...h, index, findingIds: [...new Set(ids)] };
    });
    return { path: `skills/${f}`, original: originalText, proposed: proposedText, hunks };
  });
  return { patches, files };
}
