import { asc, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { requests, runs } from '../db/schema.js';
import type { SourceRef } from '../grading/schema.js';
import { commandsOf } from '../stages/shell.js';
import { loadTask } from '../tasks/loader.js';
import { alternation, excerpt, LINEAR_TOOL, mainSeqResolver, strings } from './cross-run-refs.js';

// Contracts 第 13 节"读取来源的记录"：只记访问来源的动作，引用正文不算
//   ticket：Linear 工具的输入中出现来源工单编号；
//   pr：gh、git、curl、wget 命令的参数或 WebFetch 的 url 中出现来源仓库与 source.github.prs 中的 PR 编号
//       （gh pr <子命令> N --repo owner/name、owner/name/pull/N、owner/name/pulls/N）；
//   repo：同样范围内出现来源仓库 owner/name，且这次调用没有记 pr

// 访问 GitHub 的命令
const FETCHERS = new Set(['gh', 'git', 'curl', 'wget']);
// 值是自由文本的选项（PR 正文、标题、提交信息、请求体）：其中引用的仓库名不是访问
const TEXT_FLAGS = new Set([
  '--body',
  '-b',
  '--body-file',
  '-F',
  '--title',
  '-t',
  '--message',
  '-m',
  '--notes',
  '--description',
  '-d',
  '--data',
  '--data-raw',
  '--data-binary',
]);

// 仓库名前后不能是字母、数字、-、_ 或 .
const REPO_EDGE = '[A-Za-z0-9_.-]';

interface Target {
  // 摘录的字段路径与全文（command 或 url）
  at: string;
  text: string;
  // 参与匹配的参数
  args: string[];
  // gh pr <子命令>：其后的数字参数是 PR 编号
  ghPr: boolean;
}

// 命令参数中去掉自由文本选项的值（--body x 与 --body=x 两种写法）
function accessArgs(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (TEXT_FLAGS.has(arg)) {
      i++;
      continue;
    }
    const eq = arg.indexOf('=');
    if (arg.startsWith('-') && eq > 0 && TEXT_FLAGS.has(arg.slice(0, eq))) continue;
    out.push(arg);
  }
  return out;
}

function targets(name: string, input: unknown): Target[] {
  const fields = strings(input);
  if (name === 'Bash') {
    const command = fields.find((f) => f.at === 'command');
    if (command === undefined) return [];
    return commandsOf(command.text)
      .filter((argv) => FETCHERS.has(argv[0] ?? ''))
      .map((argv) => ({
        at: 'command',
        text: command.text,
        args: accessArgs(argv),
        ghPr: argv[0] === 'gh' && argv[1] === 'pr',
      }));
  }
  if (name === 'WebFetch') {
    return fields
      .filter((f) => f.at === 'url')
      .map((f) => ({ at: 'url', text: f.text, args: [f.text], ghPr: false }));
  }
  return [];
}

interface Hit {
  kind: SourceRef['kind'];
  excerpt: string;
}

// 摘录定位到参数在全文中的位置
function hitAt(kind: SourceRef['kind'], t: Target, needle: string): Hit {
  const start = Math.max(0, t.text.indexOf(needle));
  return { kind, excerpt: excerpt(t.at, t.text, start, start + needle.length) };
}

function accessHits(t: Target, repo: RegExp, prPath: RegExp, prs: number[]): Hit[] {
  const withRepo = t.args.filter((a) => repo.test(a));
  repo.lastIndex = 0;
  if (withRepo.length === 0) return [];
  for (const arg of t.args) {
    for (const m of arg.matchAll(prPath)) {
      if (prs.includes(Number(m[1]))) return [hitAt('pr', t, m[0])];
    }
  }
  if (t.ghPr) {
    const number = t.args.slice(2).find((a) => /^\d+$/.test(a) && prs.includes(Number(a)));
    if (number !== undefined) return [hitAt('pr', t, `gh pr ${t.args[1] ?? ''} ${number}`)];
  }
  const first = withRepo[0] ?? '';
  return [hitAt('repo', t, first.match(repo)?.[0] ?? first)];
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
  if (task.source === undefined) return [];
  const rows = db
    .select()
    .from(requests)
    .where(eq(requests.sessionId, run.sessionId))
    .orderBy(asc(requests.timestamp), asc(requests.id))
    .all();
  if (rows.length === 0) return [];

  const { repo: sourceRepo, prs } = task.source.github;
  const name = alternation([sourceRepo]);
  const ticket = new RegExp(
    `(?<![A-Za-z0-9-])${alternation([task.source.linear.identifier])}(?![0-9])`,
    'g',
  );
  const repo = new RegExp(`(?<!${REPO_EDGE})${name}(?!${REPO_EDGE})`, 'i');
  const prPath = new RegExp(`(?<!${REPO_EDGE})${name}/pulls?/(\\d+)\\b`, 'gi');

  const mainSeq = mainSeqResolver(db, run.sessionId, rows);
  const refs: SourceRef[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const call of row.toolCalls) {
      const hits: Hit[] = [];
      if (LINEAR_TOOL.test(call.name)) {
        for (const { at, text } of strings(call.input)) {
          for (const m of text.matchAll(ticket)) {
            hits.push({
              kind: 'ticket',
              excerpt: excerpt(at, text, m.index, m.index + m[0].length),
            });
          }
        }
      }
      for (const t of targets(call.name, call.input)) {
        hits.push(...accessHits(t, repo, prPath, prs));
      }
      // 同一调用中既有 pr 又有 repo 时只记 pr
      const kinds = new Set(hits.map((h) => h.kind));
      for (const hit of hits) {
        if (hit.kind === 'repo' && kinds.has('pr')) continue;
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
