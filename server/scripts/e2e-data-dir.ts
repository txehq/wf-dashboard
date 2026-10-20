import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { z } from 'zod';

// 保留在多次运行之间的 e2e 数据目录（.work/e2e/runs-data）。drizzle 的 migrate 只比较最后一次执行的迁移时间：
// 分支上执行过的迁移在 main 中改了编号与时间时会再执行一次（"duplicate column name"），时间更早的迁移不会执行。
// 所以准备时比较数据库中执行过的迁移与仓库中的迁移，不一致时删除整个数据目录：
// 目录中 variant 的 home 与 Live 的文件对应数据库中的行（resume 时复制的 session 由 live_processes 记录），只删数据库会留下它们

const Journal = z.object({
  entries: z.array(z.object({ idx: z.number().int(), when: z.number().int(), tag: z.string() })),
});

interface Applied {
  hash: string;
  createdAt: number;
}

// 数据库中执行过的迁移与仓库中的不同之处；没有数据库时为空（准备脚本新建）
export function migrationDifferences(dbPath: string, migrationsDir: string): string[] {
  if (!fs.existsSync(dbPath)) return [];
  const journal = Journal.parse(
    JSON.parse(fs.readFileSync(path.join(migrationsDir, 'meta', '_journal.json'), 'utf8')),
  );
  const files = readMigrationFiles({ migrationsFolder: migrationsDir });
  const repo = journal.entries.map((e, i) => {
    const file = files[i];
    if (file?.folderMillis !== e.when) throw new Error(`迁移 ${e.tag} 与 journal 不对应`);
    return { tag: e.tag, hash: file.hash, createdAt: e.when };
  });
  const sqlite = new Database(dbPath);
  const table = sqlite
    .prepare(
      "select name from sqlite_master where type = 'table' and name = '__drizzle_migrations'",
    )
    .get();
  const applied =
    table === undefined
      ? []
      : sqlite
          .prepare<[], { hash: string; created_at: number }>(
            'select hash, created_at from __drizzle_migrations order by created_at',
          )
          .all()
          .map((r): Applied => ({ hash: r.hash, createdAt: r.created_at }));
  sqlite.close();
  if (table === undefined) return ['数据库中没有迁移记录'];

  // 数据库中只有内容的 hash 与执行时用的迁移时间：按时间找仓库中的迁移，找不到时按内容找
  const describe = (a: Applied) => {
    const at = new Date(a.createdAt).toISOString();
    const sameTime = repo.find((r) => r.createdAt === a.createdAt);
    if (sameTime !== undefined) return `${sameTime.tag}（${at}）`;
    const sameHash = repo.find((r) => r.hash === a.hash);
    if (sameHash !== undefined) return `与 ${sameHash.tag} 内容相同的迁移（${at}）`;
    return `仓库中没有的迁移（${at}）`;
  };
  const out: string[] = [];
  for (let i = 0; i < Math.max(repo.length, applied.length); i++) {
    const a = applied[i];
    const r = repo[i];
    if (a === undefined && r !== undefined) out.push(`数据库中少了 ${r.tag}`);
    else if (a !== undefined && r === undefined) out.push(`数据库中多了 ${describe(a)}`);
    else if (
      a !== undefined &&
      r !== undefined &&
      (a.hash !== r.hash || a.createdAt !== r.createdAt)
    )
      out.push(`第 ${String(i)} 个迁移在数据库中是 ${describe(a)}，仓库中是 ${r.tag}`);
  }
  return out;
}

// 迁移不一致时删除数据目录并打印原因，返回原因
export function resetOnMigrationChange(dataDir: string, dbPath: string, migrationsDir: string) {
  const reasons = migrationDifferences(dbPath, migrationsDir);
  if (reasons.length > 0) {
    console.log(`删除重建 ${dataDir}：${reasons.join('；')}`);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  return reasons;
}
