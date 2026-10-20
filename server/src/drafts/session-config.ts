import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { type LiveEngine, type LivePurpose, liveProcesses, liveSessions } from '../db/schema.js';
import { events } from '../events.js';
import { type DraftLayout, draftLayout, sessionSkillsDir } from './dir.js';

// 设计与优化会话的工作目录：优化会话的 src/ 在 optimize/ 下（Contracts 19.3）
export const sessionLayoutOf = (item: { cwd: string; purpose: LivePurpose }) =>
  draftLayout(item.cwd, item.purpose === 'optimize' ? 'optimize' : 'workflow');

// src/skills 装进会话自己的配置（Contracts 28.2）：Claude Code 为 claude-config/skills/（用户范围），
// Codex 为工作目录的 .agents/skills/，与三个工具 skill 并列
export const sessionSrcSkillsDir = (layout: DraftLayout, engine: LiveEngine) =>
  engine === 'codex' ? layout.agentSkills : path.join(layout.claudeDir, 'skills');

// 工作目录中记下哪些 skill 是从 src/skills 装的：只删除、覆盖这些
const SYNCED_FILE = '.session-src-skills.json';

const dirNames = (dir: string) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort()
    : [];

// 两个目录的文件、符号链接与内容都相同
function sameTree(a: string, b: string): boolean {
  if (!fs.existsSync(b)) return false;
  const entries = (dir: string) =>
    fs
      .readdirSync(dir, { recursive: true, withFileTypes: true })
      .map((e) => ({ rel: path.relative(dir, path.join(e.parentPath, e.name)), entry: e }))
      .sort((x, y) => x.rel.localeCompare(y.rel));
  const left = entries(a);
  const right = entries(b);
  if (left.length !== right.length) return false;
  return left.every(({ rel, entry }, i) => {
    const other = right[i];
    if (other?.rel !== rel) return false;
    if (entry.isSymbolicLink()) {
      return (
        other.entry.isSymbolicLink() &&
        fs.readlinkSync(path.join(a, rel)) === fs.readlinkSync(path.join(b, rel))
      );
    }
    if (entry.isDirectory()) return other.entry.isDirectory();
    return (
      other.entry.isFile() &&
      fs.readFileSync(path.join(a, rel)).equals(fs.readFileSync(path.join(b, rel)))
    );
  });
}

// 让会话配置中的 src skill 与 src/skills 一致：新增与改动的整个目录重新复制，src/skills 中删除的从配置中删除。
// 三个工具 skill、platform-mcp、optimize-from-report 与 agent 用 find-skills 装的不是从 src/skills 装的，
// 同名的 src skill 不装，也不删除它们。返回装着的 src skill
export function syncSessionSkills(layout: DraftLayout, engine: LiveEngine): string[] {
  const target = sessionSrcSkillsDir(layout, engine);
  fs.mkdirSync(target, { recursive: true });
  const manifest = path.join(layout.dir, SYNCED_FILE);
  const previous = fs.existsSync(manifest)
    ? z.array(z.string()).parse(JSON.parse(fs.readFileSync(manifest, 'utf8')))
    : [];
  const own = new Set(previous);
  const reserved = new Set(
    [...dirNames(target), ...dirNames(sessionSkillsDir(layout, engine))].filter(
      (name) => !own.has(name),
    ),
  );
  const names = dirNames(layout.skills).filter((name) => !reserved.has(name));
  for (const name of previous) {
    if (!names.includes(name)) fs.rmSync(path.join(target, name), { recursive: true, force: true });
  }
  for (const name of names) {
    const from = path.join(layout.skills, name);
    const to = path.join(target, name);
    if (sameTree(from, to)) continue;
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  }
  const tmp = `${manifest}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(names)}\n`);
  fs.renameSync(tmp, manifest);
  return names;
}

// 比较 src/skills 的间隔，与 workflow 面板的监视相同（Contracts 26.4）
const POLL_MS = 250;

// src/skills 下每一项（文件、目录、符号链接）的 mtime、大小与 inode
function signatureOf(dir: string): string {
  if (!fs.existsSync(dir)) return '';
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((e) => {
      const file = path.join(e.parentPath, e.name);
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      return stat === undefined
        ? ''
        : `${path.relative(dir, file)}:${String(stat.mtimeMs)}:${String(stat.size)}:${String(stat.ino)}`;
    })
    .sort()
    .join('\n');
}

interface Poller {
  signature: string;
  timer: ReturnType<typeof setInterval>;
}

// 设计与优化会话的进程运行时随写随装（Contracts 28.2）：每 250 ms 比较 src/skills，有变化就同步进会话配置。
// 启动与 resume 前由 Live 同步一次，这里只管进程运行期间；进程结束、项关闭或删除时停止
export function createSessionSync({ db }: { db: Db }) {
  const pollers = new Map<string, Poller>();

  function stop(liveId: string) {
    const poller = pollers.get(liveId);
    if (poller === undefined) return;
    clearInterval(poller.timer);
    pollers.delete(liveId);
  }

  function update(liveId: string) {
    const item = db
      .select({
        cwd: liveSessions.cwd,
        purpose: liveSessions.purpose,
        engine: liveSessions.engine,
        hiddenAt: liveSessions.hiddenAt,
      })
      .from(liveSessions)
      .where(eq(liveSessions.id, liveId))
      .get();
    const running =
      item?.hiddenAt === null &&
      (item.purpose === 'design' || item.purpose === 'optimize') &&
      db
        .select({ id: liveProcesses.id })
        .from(liveProcesses)
        .where(and(eq(liveProcesses.liveId, liveId), eq(liveProcesses.status, 'running')))
        .get() !== undefined;
    if (!running) {
      stop(liveId);
      return;
    }
    if (pollers.has(liveId)) return;
    const layout = sessionLayoutOf(item);
    const poller: Poller = {
      // 第一次比较时同步一次：Live 启动前的同步之后到这里的改动（不在发布事件的调用中同步，出错时不影响启动）
      signature: '',
      // 不能从定时器中抛出（成为 uncaught exception，整个服务退出）：出错时记下原文并停止，下次启动或 resume 前
      // Live 再同步一次（出错时在那里抛出）
      timer: setInterval(() => {
        try {
          const next = signatureOf(layout.skills);
          if (next === poller.signature) return;
          poller.signature = next;
          syncSessionSkills(layout, item.engine);
        } catch (error) {
          console.error(
            `[session-skills] 交互 ${liveId} 的 src/skills 同步失败，停止随写随装：${error instanceof Error ? error.message : String(error)}`,
          );
          stop(liveId);
        }
      }, POLL_MS),
    };
    pollers.set(liveId, poller);
  }

  const unsubscribe = events.subscribe((event) => {
    if (event.type === 'live.updated') update(event.liveId);
  });

  return {
    // 正在随写随装的项
    active: () => [...pollers.keys()],
    shutdown() {
      unsubscribe();
      for (const liveId of [...pollers.keys()]) stop(liveId);
    },
  };
}

export type SessionSync = ReturnType<typeof createSessionSync>;
