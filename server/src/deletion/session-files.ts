import fs from 'node:fs';
import path from 'node:path';
import { inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { sessions } from '../db/schema.js';
import { forgetImports } from '../ingest/imports.js';

// 删除 Claude Code 的 session 时一起删除的文件（Contracts 24.2、25.3，Claude Code 2.1.295 实测）：主 jsonl、
// 同名的子代理与 tool-results 目录；session 在配置目录（<配置目录>/projects/<项目>/<id>.jsonl）中时，另有
// <配置目录>/file-history/<id> 与 session-env/<id>。只列出存在的
export function claudeSessionFiles(s: { id: string; filePath: string }): string[] {
  const projectDir = path.dirname(s.filePath);
  const files = [s.filePath, path.join(projectDir, s.id)];
  if (path.basename(path.dirname(projectDir)) === 'projects') {
    const configDir = path.dirname(path.dirname(projectDir));
    files.push(
      path.join(configDir, 'file-history', s.id),
      path.join(configDir, 'session-env', s.id),
    );
  }
  return files.filter((f) => fs.existsSync(f));
}

// 永久删除 Claude Code 的 session：dashboard 中的 session（子代理、请求、阶段、绑定随外键删除）与磁盘上的这些文件。
// 属于它们的 Live 项由调用者先删除（live.removeItem，要求没有运行中的进程）。删除 variant 与 workflow 时的
// "一起删除"（24.2）与 Sessions 页面的删除（25.3）共用
export function deleteClaudeSessions(db: Db, rows: { id: string; filePath: string }[]): string[] {
  if (rows.length === 0) return [];
  const files = rows.flatMap(claudeSessionFiles);
  const ids = rows.map((s) => s.id);
  db.delete(sessions).where(inArray(sessions.id, ids)).run();
  forgetImports(db, ids);
  for (const f of files) fs.rmSync(f, { recursive: true, force: true });
  return files;
}
