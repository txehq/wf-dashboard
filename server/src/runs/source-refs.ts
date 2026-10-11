import { asc, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { requests, runs } from '../db/schema.js';
import type { SourceRef } from '../grading/schema.js';
import { loadTask } from '../tasks/loader.js';
import { alternation, excerpt, LINEAR_TOOL, mainSeqResolver, strings } from './cross-run-refs.js';

// Contracts 第 13 节"读取来源的记录"：从 Linear 导入的 task 的 run 中，requests（含子代理）里指向来源的访问
//   ticket：Linear 工具的输入或结果中出现来源工单编号；
//   pr：命令或工具输入中出现来源仓库的 PR 编号（gh pr <子命令> N --repo owner/name、owner/name/pull/N、owner/name/pulls/N）；
//   repo：命令或工具输入中出现来源仓库 owner/name，且不是上面的 PR 引用

// 仓库名前后不能是字母、数字、-、_ 或 .
const REPO_EDGE = '[A-Za-z0-9_.-]';

interface Hit {
  kind: SourceRef['kind'];
  excerpt: string;
}

function ticketHits(at: string, text: string, ticket: RegExp): Hit[] {
  return [...text.matchAll(ticket)].map((m) => ({
    kind: 'ticket' as const,
    excerpt: excerpt(at, text, m.index, m.index + m[0].length),
  }));
}

function repoHits(at: string, text: string, repo: RegExp, prPath: RegExp): Hit[] {
  const hits: Hit[] = [];
  const repoMatches = [...text.matchAll(repo)];
  if (repoMatches.length === 0) return hits;
  // gh 的 PR 子命令以编号指向 --repo / -R 给出的仓库
  const ghPr = [...text.matchAll(/\bgh\s+pr\s+[a-z-]+\s+(\d+)\b/g)];
  const paths = [...text.matchAll(prPath)];
  for (const m of [...ghPr, ...paths]) {
    hits.push({ kind: 'pr', excerpt: excerpt(at, text, m.index, m.index + m[0].length) });
  }
  if (hits.length === 0) {
    const first = repoMatches[0];
    if (first !== undefined) {
      hits.push({
        kind: 'repo',
        excerpt: excerpt(at, text, first.index, first.index + first[0].length),
      });
    }
  }
  return hits;
}

// 每个 (tool 调用, kind) 一条，摘录取第一次出现的位置；按主 session seq 排序。不是从 Linear 导入的 task 为空数组
export function scanSourceRefs(db: Db, runId: string): SourceRef[] {
  const run = db
    .select({ sessionId: runs.sessionId, taskId: runs.taskId })
    .from(runs)
    .where(eq(runs.id, runId))
    .get();
  if (run === undefined) throw new Error(`run ${runId} 不存在`);
  const task = loadTask(db, run.taskId);
  if (task.kind !== 'ic' || task.source === undefined) return [];
  const rows = db
    .select()
    .from(requests)
    .where(eq(requests.sessionId, run.sessionId))
    .orderBy(asc(requests.timestamp), asc(requests.id))
    .all();
  if (rows.length === 0) return [];

  const name = alternation([task.source.github.repo]);
  const ticket = new RegExp(
    `(?<![A-Za-z0-9-])${alternation([task.source.linear.identifier])}(?![0-9])`,
    'g',
  );
  const repo = new RegExp(`(?<!${REPO_EDGE})${name}(?!${REPO_EDGE})`, 'gi');
  const prPath = new RegExp(`(?<!${REPO_EDGE})${name}/pulls?/(\\d+)\\b`, 'gi');

  const mainSeq = mainSeqResolver(db, run.sessionId, rows);
  const refs: SourceRef[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const call of row.toolCalls) {
      const hits: Hit[] = [];
      for (const { at, text } of strings(call.input)) {
        if (LINEAR_TOOL.test(call.name)) hits.push(...ticketHits(at, text, ticket));
        hits.push(...repoHits(at, text, repo, prPath));
      }
      if (LINEAR_TOOL.test(call.name) && call.result !== null) {
        hits.push(...ticketHits('result', call.result, ticket));
      }
      for (const hit of hits) {
        const key = `${call.id}\0${hit.kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push({
          kind: hit.kind,
          requestSeq: mainSeq(row),
          toolCallId: call.id,
          excerpt: hit.excerpt,
        });
      }
    }
  }
  return refs.sort((a, b) => a.requestSeq - b.requestSeq);
}
