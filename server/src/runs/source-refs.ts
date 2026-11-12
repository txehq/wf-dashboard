import { asc, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { requests, runs } from '../db/schema.js';
import type { SourceRef } from '../grading/schema.js';
import { commandsOf } from '../stages/shell.js';
import { loadTask } from '../tasks/loader.js';
import { alternation, excerpt, LINEAR_TOOL, mainSeqResolver, strings } from './cross-run-refs.js';

// Contracts section 13 "records of reading the sources": only actions that access a source count, quoting text does not
//   ticket: a source ticket id appears in a Linear tool's input;
//   pr: the source repo and a PR number from source.github.prs appear in the arguments of a gh, git, curl or wget
//       command or in a WebFetch url (gh pr <subcommand> N --repo owner/name, owner/name/pull/N, owner/name/pulls/N);
//   repo: the source repo owner/name appears in the same places and this call recorded no pr

// Commands that access GitHub
const FETCHERS = new Set(['gh', 'git', 'curl', 'wget']);
// Options whose value is free text (PR body, title, commit message, request body): repo names quoted there are not
// accesses
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

// A repo name may not be preceded or followed by a letter, digit, -, _ or .
const REPO_EDGE = '[A-Za-z0-9_.-]';

interface Target {
  // The excerpt's field path and full text (command or url)
  at: string;
  text: string;
  // The arguments that are matched
  args: string[];
  // gh pr <subcommand>: the numeric argument after it is a PR number
  ghPr: boolean;
}

// Drop the values of free-text options from command arguments (both --body x and --body=x)
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

// Locate the excerpt at the argument's position in the full text
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

// One per (tool call, kind), the excerpt at the first occurrence, sorted by main session seq. Empty for tasks not
// imported from Linear
export function scanSourceRefs(db: Db, runId: string): SourceRef[] {
  const run = db
    .select({ sessionId: runs.sessionId, taskId: runs.taskId })
    .from(runs)
    .where(eq(runs.id, runId))
    .get();
  if (run === undefined) throw new Error(`Run not found: ${runId}`);
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
      // When one call has both pr and repo, only pr is recorded
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
