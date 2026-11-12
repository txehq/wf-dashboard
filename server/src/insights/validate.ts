import fs from 'node:fs';
import path from 'node:path';
import { diffArrays, parsePatch } from 'diff';
import { execa } from 'execa';
import { z } from 'zod';
import {
  analysisOutcomes,
  type AnalysisReport,
  type FindingEvidence,
  findingSeverities,
} from '../db/schema.js';
import type { ExportedRow } from './export.js';

// Contracts 15.2, 19.2: format of the engine's output files and the dashboard's validation; fails with the original text when unmet

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
  // The aspect is a session-analysis sub-stage
  aspect: string;
  evidence: FindingEvidence[];
}

export const findingsFile = (aspect: string) => `findings-${aspect}.json`;

function readJson(file: string): unknown {
  if (!fs.existsSync(file)) throw new Error(`The engine did not write ${file}`);
  const text = fs.readFileSync(file, 'utf8');
  return JSON.parse(text);
}

// All string values in an exported row (recursive); a quote must be a substring of one of them
function strings(value: unknown, out: string[]) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (typeof value === 'object' && value !== null)
    for (const v of Object.values(value)) strings(v, out);
}

// What each main-agent seq of each session may cite: that row and the subagent rows whose parentSeq points to it
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
          `parentSeq ${String(r.parentSeq)} of a subagent row in session ${sessionId} does not exist`,
        );
      strings(r, list);
    }
    index.set(sessionId, bySeq);
  }
  return index;
}

// Validate one aspect's output: zod format, and each evidence's seq exists and its quote is a substring of that row's export
export function validateFindings(
  file: string,
  aspect: string,
  index: EvidenceIndex,
): ValidatedFinding[] {
  const parsed = z.array(EngineFinding).safeParse(readJson(file));
  if (!parsed.success) {
    throw new Error(
      `${path.basename(file)} has an invalid format: ${z.prettifyError(parsed.error)}`,
    );
  }
  const problems: string[] = [];
  const findings = parsed.data.map((f, i): ValidatedFinding => {
    for (const e of f.evidence) {
      const where = `Evidence ${e.sessionId}#${String(e.seq)} of finding ${String(i + 1)} "${f.title}"`;
      const session = index.get(e.sessionId);
      if (session === undefined) {
        problems.push(`${where}: session is not in this analysis's scope`);
        continue;
      }
      const texts = session.get(e.seq);
      if (texts === undefined) {
        problems.push(`${where}: main agent has no seq ${String(e.seq)}`);
        continue;
      }
      if (!texts.some((t) => t.includes(e.quote))) {
        problems.push(
          `${where}: quote is not a substring of the row's export: ${JSON.stringify(e.quote)}`,
        );
      }
    }
    return { ...f, findingId: `${aspect}-${String(i + 1)}`, aspect };
  });
  if (problems.length > 0) {
    throw new Error(
      `Evidence validation of ${path.basename(file)} failed:\n${problems.join('\n')}`,
    );
  }
  return findings;
}

// Write the findings with ids back to the output dir for the synthesize step to cite
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

const FindingIds = z.array(z.string().min(1)).min(1);

export const EngineReport = z.strictObject({
  summary: z.string().trim().min(1),
  goal: z.string().trim().min(1),
  outcome: z.enum(analysisOutcomes),
  topIssues: z.array(
    z.strictObject({
      title: z.string().trim().min(1),
      findingIds: FindingIds,
      impact: z.string().trim().min(1),
    }),
  ),
  workflowChanges: z.array(
    z.strictObject({
      findingIds: FindingIds,
      rationale: z.string().trim().min(1),
      change: z.string().trim().min(1),
    }),
  ),
});

// Validate output/report.json (Contracts 19.2): zod format, every findingId exists
export function validateReport(file: string, findingIds: Set<string>): AnalysisReport {
  const parsed = EngineReport.safeParse(readJson(file));
  if (!parsed.success) {
    throw new Error(`report.json has an invalid format: ${z.prettifyError(parsed.error)}`);
  }
  const report = parsed.data;
  const referenced = [
    ...report.topIssues.flatMap((i) => i.findingIds),
    ...report.workflowChanges.flatMap((c) => c.findingIds),
  ];
  const unknown = [...new Set(referenced.filter((id) => !findingIds.has(id)))];
  if (unknown.length > 0) {
    throw new Error(`report.json validation failed: unknown findingIds: ${unknown.join(', ')}`);
  }
  return report;
}

// One change: at original line start (0-based) remove `remove` and insert `insert`; lines include the newline
export interface Hunk {
  index: number;
  start: number;
  remove: string[];
  insert: string[];
  findingIds: string[];
}

export interface FileProposal {
  // Path relative to src/, e.g. skills/ic/SKILL.md
  path: string;
  original: string;
  proposed: string;
  hunks: Hunk[];
}

const splitLines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

// Changes between original and proposed; adjacent removals and insertions merge into one
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

// Build the result from the selected changes (same algorithm as the page)
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

// git in the analysis dir must not reach the dashboard repo containing it: GIT_CEILING_DIRECTORIES stops the upward search
async function gitApply(cwd: string, ceiling: string, args: string[]) {
  return execa('git', ['apply', ...args], {
    cwd,
    reject: false,
    env: { GIT_CEILING_DIRECTORIES: ceiling },
  });
}

const stripPrefix = (name: string | undefined) =>
  name === undefined || name === '/dev/null' ? null : name.replace(/^[ab]\//, '');

// Validate patches.json: format, findingIds exist, each patch changes only its one file and deletes none,
// git apply --check -p1 on a copy of input/skills; then apply all in order to get each file's result and its changes
export async function validatePatches(
  file: string,
  skillsDir: string,
  workDir: string,
  findingIds: Set<string>,
): Promise<{ patches: EnginePatch[]; files: FileProposal[] }> {
  const parsed = z.array(EnginePatch).safeParse(readJson(file));
  if (!parsed.success) {
    throw new Error(`patches.json has an invalid format: ${z.prettifyError(parsed.error)}`);
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
    const where = `Patch ${String(i + 1)} (${p.file})`;
    const unknown = p.findingIds.filter((id) => !findingIds.has(id));
    if (unknown.length > 0) problems.push(`${where}: unknown findingIds: ${unknown.join(', ')}`);
    const parts = parsePatch(p.patch);
    const targets = parts.map((d) => ({
      old: stripPrefix(d.oldFileName),
      new: stripPrefix(d.newFileName),
    }));
    if (targets.length !== 1 || targets[0]?.new !== p.file) {
      problems.push(
        `${where}: patch must change only ${p.file}, but changes ${JSON.stringify(targets)}`,
      );
      continue;
    }
    if (targets[0].old !== null && targets[0].old !== p.file) {
      problems.push(`${where}: patch's original file is ${targets[0].old}, not file`);
      continue;
    }
    const patchFile = path.join(workDir, `patch-${String(i + 1)}.diff`);
    fs.writeFileSync(patchFile, p.patch.endsWith('\n') ? p.patch : `${p.patch}\n`);
    const check = await gitApply(original, workDir, ['--check', '-p1', patchFile]);
    if (check.exitCode !== 0) {
      problems.push(`${where}: git apply --check failed: ${check.stderr.trim()}`);
      continue;
    }
    // Apply alone to a copy holding only that file to get the lines it changes in the original
    const single = path.join(workDir, `single-${String(i + 1)}`);
    const before = path.join(original, p.file);
    const beforeText = fs.existsSync(before) ? fs.readFileSync(before, 'utf8') : '';
    fs.mkdirSync(path.dirname(path.join(single, p.file)), { recursive: true });
    if (fs.existsSync(before)) fs.copyFileSync(before, path.join(single, p.file));
    const alone = await gitApply(single, workDir, ['-p1', patchFile]);
    if (alone.exitCode !== 0)
      throw new Error(`${where}: applying alone failed: ${alone.stderr.trim()}`);
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
  if (problems.length > 0)
    throw new Error(`patches.json validation failed:\n${problems.join('\n')}`);

  for (const [i, p] of patches.entries()) {
    const applied = await gitApply(proposed, workDir, [
      '-p1',
      path.join(workDir, `patch-${String(i + 1)}.diff`),
    ]);
    if (applied.exitCode !== 0) {
      throw new Error(
        `Patch ${String(i + 1)} (${p.file}) overlaps content changed by an earlier patch; applying in order failed: ${applied.stderr.trim()}`,
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
      // Changes of single patches that overlap or touch this change, i.e. its findings
      const ids = ranges
        .filter((r) => r.changed.some((c) => c.start <= end && h.start <= c.end))
        .flatMap((r) => r.ids);
      return { ...h, index, findingIds: [...new Set(ids)] };
    });
    return { path: `skills/${f}`, original: originalText, proposed: proposedText, hunks };
  });
  return { patches, files };
}
