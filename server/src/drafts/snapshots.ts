import fs from 'node:fs';
import path from 'node:path';
import { listSkillFiles } from '../variants/skills.js';
import type { DraftLayout } from './dir.js';

// What Compare in the design and optimize session panel compares against (Contracts 26.4, 28.4): the previous snapshot and a copy of the last save,
// kept in .dashboard/workspace/ managed by the dashboard under the draft dir (the analysis dir when optimising). Each one holds skills/, structured like src/,
// with files read as skills/<skill>/<file>
const managedDir = (layout: DraftLayout) => path.join(layout.dir, '.dashboard', 'workspace');
const snapshotsDir = (layout: DraftLayout) => path.join(managedDir(layout), 'snapshots');
const savedDir = (layout: DraftLayout) => path.join(managedDir(layout), 'saved');

// Keep only the latest two: when the working dir equals the latest, the previous version is the second to last
const KEEP = 2;

// Files under skills/ (relative to this copy's root); empty when there is no skills/
const filesIn = (root: string) =>
  fs.existsSync(path.join(root, 'skills')) ? listSkillFiles(root) : [];

// Copy src/skills to dest/skills. Symlinks are not files and are not copied; files the agent deletes between listing and copying are skipped
// (the next comparison counts this change as usual)
function copySkills(src: string, dest: string) {
  fs.mkdirSync(path.join(dest, 'skills'), { recursive: true });
  for (const file of filesIn(src)) {
    const from = path.join(src, file);
    if (!fs.existsSync(from)) continue;
    const to = path.join(dest, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

// Whether two skills/ copies have exactly the same files and contents
function sameSkills(a: string, b: string): boolean {
  const left = filesIn(a);
  const right = filesIn(b);
  if (left.length !== right.length || left.some((f, i) => f !== right[i])) return false;
  return left.every((file) => {
    const x = path.join(a, file);
    const y = path.join(b, file);
    return fs.existsSync(x) && fs.existsSync(y) && fs.readFileSync(x).equals(fs.readFileSync(y));
  });
}

// Recorded snapshots, oldest first; the dir name is the record time in ms (<at>.tmp is half-written)
function snapshots(layout: DraftLayout): { at: number; root: string }[] {
  const dir = snapshotsDir(layout);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /^\d+$/.test(name))
    .map((name) => ({ at: Number(name), root: path.join(dir, name) }))
    .sort((a, b) => a.at - b.at);
}

// Called after the working dir's src/skills has been still for 5 seconds: records a new copy when it differs from the latest; returns whether it did
export function recordSnapshot(layout: DraftLayout, now: number): boolean {
  const all = snapshots(layout);
  const latest = all.at(-1);
  if (latest !== undefined && sameSkills(layout.src, latest.root)) return false;
  const at = Math.max(now, (latest?.at ?? 0) + 1);
  const dir = snapshotsDir(layout);
  const tmp = path.join(dir, `${String(at)}.tmp`);
  fs.rmSync(tmp, { recursive: true, force: true });
  copySkills(layout.src, tmp);
  fs.renameSync(tmp, path.join(dir, String(at)));
  for (const old of [...all, { at, root: '' }].slice(0, -KEEP)) {
    fs.rmSync(old.root, { recursive: true, force: true });
  }
  return true;
}

// Previous version: the second to last when the working dir equals the latest snapshot, otherwise the latest
export function previousSnapshot(layout: DraftLayout): { at: number; root: string } | null {
  const all = snapshots(layout);
  const latest = all.at(-1);
  if (latest === undefined) return null;
  return sameSkills(layout.src, latest.root) ? (all.at(-2) ?? null) : latest;
}

// Copy src/skills after a successful save (Contracts 17.4): the "Last saved" copy
export function recordSaved(layout: DraftLayout) {
  const dir = savedDir(layout);
  const tmp = `${dir}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  copySkills(layout.src, tmp);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
}

export function savedCopy(layout: DraftLayout): { at: number; root: string } | null {
  const dir = savedDir(layout);
  const stat = fs.statSync(dir, { throwIfNoEntry: false });
  return stat === undefined ? null : { at: stat.mtimeMs, root: dir };
}
