import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toString } from 'mdast-util-to-string';
import { z } from 'zod';
import { inputString, type RequestRow } from './rows.js';
import { commandsOf, type ObsidianArgs, obsidianArgs } from './shell.js';
import type { LfgStage } from './workflow.js';

// feature 目录中的固定文件名与 wf obsidian 写入的 frontmatter kind
export const LFG_DOCS = {
  brief: { file: 'Brief.md', kind: 'brief' },
  research: { file: 'Research.md', kind: 'research' },
  design: { file: 'System Design.md', kind: 'design' },
  tickets: { file: 'Tickets.md', kind: 'tickets' },
} as const;
type DocKey = keyof typeof LFG_DOCS;

// 与 wf obsidian 的 slugify 一致
export function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function featureDir(vault: string, product: string, feature: string): string {
  const name = product.startsWith('Project ') ? product : `Project ${product}`;
  return path.join(vault, name, 'Features', slugify(feature));
}

const PLAN_HEADING = /^(?:\d+\.\s*)?(?:plan|计划|实施计划)(?![a-z])/i;
const LOCKED_STATUS = /^(?:status|状态)\s*[:：]\s*locked\b/i;

// 正文（不含 frontmatter）中 Plan 一节的锁定状态行；没有时为 null
export function planLockedLine(body: string): string | null {
  const tree = fromMarkdown(body);
  let inPlan = false;
  for (const node of tree.children) {
    if (node.type === 'heading' && node.depth <= 2) {
      inPlan = node.depth === 2 && PLAN_HEADING.test(toString(node).trim());
      continue;
    }
    if (!inPlan || node.type !== 'paragraph') continue;
    const text = toString(node).trim();
    if (LOCKED_STATUS.test(text)) return text.split('\n')[0] ?? text;
  }
  return null;
}

export interface LfgDoc {
  path: string;
  kind: string | null;
  feature: string | null;
  hash: string;
  planLockLine: string | null;
}

function readDoc(file: string): LfgDoc | null {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  const { data, content } = matter(raw);
  const fm = data as Record<string, unknown>;
  return {
    path: file,
    // 没有 frontmatter 或缺字段时为 null：不是 wf obsidian 写出的产物，下面的比较不会通过
    kind: typeof fm.kind === 'string' ? fm.kind : null,
    feature: typeof fm.feature === 'string' ? fm.feature : null,
    hash: createHash('sha256').update(raw).digest('hex'),
    planLockLine: planLockedLine(content),
  };
}

// feature 目录当前的四个产物；kind 或 feature 不符的文件不算
export function lfgSnapshot(dir: string, feature: string): Record<DocKey, LfgDoc | null> {
  const read = (key: DocKey) => {
    const doc = readDoc(path.join(dir, LFG_DOCS[key].file));
    return doc?.kind === LFG_DOCS[key].kind && doc.feature === feature ? doc : null;
  };
  return {
    brief: read('brief'),
    research: read('research'),
    design: read('design'),
    tickets: read('tickets'),
  };
}

export interface LfgLiveProgress {
  stages: Record<LfgStage, LfgDoc | null>;
  // Tickets.md 已出现而 Plan 一节没有锁定标记
  planLockMissing: boolean;
}

// 实时运行的 lfg 判定：每次 feature 目录变化后调用 observe()。
// plan 锁定要求锁定标记出现在文件首次出现之后的某次改写中，因此记住每个主文档首次被看到时的 hash。
export class LfgTracker {
  private readonly firstHash = new Map<string, string>();

  constructor(
    readonly dir: string,
    readonly feature: string,
  ) {}

  observe(): LfgLiveProgress {
    const docs = lfgSnapshot(this.dir, this.feature);
    let plan: LfgDoc | null = null;
    for (const doc of [docs.research, docs.design]) {
      if (!doc) continue;
      const first = this.firstHash.get(doc.path);
      if (first === undefined) this.firstHash.set(doc.path, doc.hash);
      else if (!plan && doc.planLockLine !== null && doc.hash !== first) plan = doc;
    }
    return {
      stages: {
        interview: docs.brief,
        research: docs.research ?? docs.design,
        plan,
        ticketing: docs.tickets,
      },
      planLockMissing: docs.tickets !== null && plan === null,
    };
  }
}

// 离线 session：写出产物的那次 wf obsidian 调用即阶段边界
export interface LfgBoundary {
  stage: LfgStage;
  seq: number;
  toolCallId: string;
  command: string;
  path: string;
  planLockLine: string | null;
}

// wf obsidian 写出的文件：<vault>/Project <P>/Features/<slug>/<固定文件名>
const WRITTEN_PATH =
  /^.*Project [^/\n]+\/Features\/[^/\n]+\/(?:Brief|Research|System Design|Tickets)\.md$/;

// --kind → 写出的固定文件名
const LFG_FILE_OF_KIND: Record<string, string> = Object.fromEntries(
  Object.values(LFG_DOCS).map((d) => [d.kind, d.file]),
);

function boundaryStage(args: ObsidianArgs): LfgStage | 'plan-candidate' | null {
  const inPlanDir = /(?:^|\/)\.plan\//.test(args.file ?? '');
  if (args.kind === 'brief') return 'interview';
  if (args.kind === 'tickets') return 'ticketing';
  if (args.kind === 'research' || args.kind === 'design') {
    if (!inPlanDir) return 'research';
    if (args.replace) return 'plan-candidate';
  }
  return null;
}

// wf --json 的输出信封（txe-workflow crates/wf-core/src/envelope.rs）
const ObsidianEnvelope = z.object({
  ok: z.boolean(),
  command: z.literal('obsidian'),
  result: z.object({ path: z.string().min(1), dry_run: z.boolean() }),
});

// 这次调用写出的文件路径：--json 时读信封的 result.path，否则为输出中打印的那一行
function writtenPath(args: ObsidianArgs, result: string): string | null {
  if (args.json) {
    const envelope = ObsidianEnvelope.parse(JSON.parse(result));
    return envelope.ok && !envelope.result.dry_run ? envelope.result.path : null;
  }
  const file = LFG_FILE_OF_KIND[args.kind ?? ''];
  return (
    result
      .split('\n')
      .map((l) => l.trim())
      .find((l) => WRITTEN_PATH.test(l) && (file === undefined || l.endsWith(`/${file}`))) ?? null
  );
}

export function lfgOfflineBoundaries(main: RequestRow[], cwd: string | null): LfgBoundary[] {
  const out: LfgBoundary[] = [];
  for (const row of main) {
    for (const call of row.toolCalls) {
      if (call.name !== 'Bash' || call.isError || call.result === null) continue;
      const command = inputString(call.input, 'command');
      if (!command?.includes('obsidian')) continue;
      for (const argv of commandsOf(command)) {
        const args = obsidianArgs(argv);
        if (args === null || args.dryRun || args.help) continue;
        const stage = boundaryStage(args);
        if (stage === null) continue;
        const printed = writtenPath(args, call.result);
        if (printed === null) continue;
        // 打印的路径相对于 agent 传入的 vault，相对路径按 session 的 cwd 解析
        if (!path.isAbsolute(printed) && cwd === null) {
          throw new Error(`wf obsidian 打印了相对路径 ${printed}，而 session 没有 cwd`);
        }
        const file = cwd === null ? printed : path.resolve(cwd, printed);
        if (!fs.existsSync(file)) continue;
        let planLockLine: string | null = null;
        if (stage === 'plan-candidate') {
          planLockLine = planLockedLine(matter(fs.readFileSync(file, 'utf8')).content);
          if (planLockLine === null) continue;
        }
        out.push({
          stage: stage === 'plan-candidate' ? 'plan' : stage,
          seq: row.seq,
          toolCallId: call.id,
          command,
          path: file,
          planLockLine,
        });
      }
    }
  }
  return out;
}
