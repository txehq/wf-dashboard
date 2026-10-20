import fs from 'node:fs';
import path from 'node:path';
import { listSkillFiles } from '../variants/skills.js';
import type { DraftLayout } from './dir.js';

// 设计与优化会话的面板中"对比"的对象（Contracts 26.4、28.4）：上一版的快照与上次保存的副本，放在草稿目录
// （优化时为分析目录）下由 dashboard 管理的 .dashboard/workspace/。每一份的目录下是 skills/，与 src/ 的结构相同，
// 文件按 skills/<skill>/<文件> 读
const managedDir = (layout: DraftLayout) => path.join(layout.dir, '.dashboard', 'workspace');
const snapshotsDir = (layout: DraftLayout) => path.join(managedDir(layout), 'snapshots');
const savedDir = (layout: DraftLayout) => path.join(managedDir(layout), 'saved');

// 只保留最新两份：工作目录与最新一份相同时，上一版是倒数第二份
const KEEP = 2;

// skills/ 下的文件（相对这一份的根）；没有 skills/ 时为空
const filesIn = (root: string) =>
  fs.existsSync(path.join(root, 'skills')) ? listSkillFiles(root) : [];

// 把 src/skills 复制到 dest/skills。符号链接不是文件，不复制；列出之后、复制之前被 agent 删除的文件不复制
// （下一次比较时这次改动照常算作变化）
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

// 两份 skills/ 的文件与内容是否完全相同
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

// 已记下的快照，从旧到新；目录名是记下时的毫秒时间（<at>.tmp 是写了一半的）
function snapshots(layout: DraftLayout): { at: number; root: string }[] {
  const dir = snapshotsDir(layout);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /^\d+$/.test(name))
    .map((name) => ({ at: Number(name), root: path.join(dir, name) }))
    .sort((a, b) => a.at - b.at);
}

// 工作目录的 src/skills 停下 5 秒后调用：与最新一份快照不同时记下新的一份，返回是否记下
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

// 上一版：工作目录与最新一份快照相同时为倒数第二份，不同时为最新一份
export function previousSnapshot(layout: DraftLayout): { at: number; root: string } | null {
  const all = snapshots(layout);
  const latest = all.at(-1);
  if (latest === undefined) return null;
  return sameSkills(layout.src, latest.root) ? (all.at(-2) ?? null) : latest;
}

// 保存（Contracts 17.4）成功后复制 src/skills，即"上次保存"
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
