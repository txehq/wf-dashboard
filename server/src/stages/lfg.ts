import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toString } from 'mdast-util-to-string';
import { inputString, type RequestRow } from './rows.js';
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
  kind: string;
  feature: string;
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
    kind: typeof fm.kind === 'string' ? fm.kind : '',
    feature: typeof fm.feature === 'string' ? fm.feature : '',
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

const WF_OBSIDIAN = /(?:^|[\n;&|(])\s*wf\s+obsidian\s/;
const NOT_A_WRITE = /--dry-run\b|--help\b|\s-h\b/;
const WRITTEN_PATH =
  /^.*Project [^/\n]+\/Features\/[^/\n]+\/(?:Brief|Research|System Design|Tickets)\.md$/m;

function flag(command: string, name: string): string | null {
  const m = new RegExp(`--${name}[\\s=]+("[^"]*"|'[^']*'|\\S+)`).exec(command);
  if (!m?.[1]) return null;
  const v = m[1];
  return /^["']/.test(v) ? v.slice(1, -1) : v;
}

function boundaryStage(command: string): LfgStage | 'plan-candidate' | null {
  const kind = flag(command, 'kind');
  const file = flag(command, 'file') ?? '';
  const inPlanDir = /(?:^|\/)\.plan\//.test(file);
  if (kind === 'brief') return 'interview';
  if (kind === 'tickets') return 'ticketing';
  if (kind === 'research' || kind === 'design') {
    if (!inPlanDir) return 'research';
    if (/--replace\b/.test(command)) return 'plan-candidate';
  }
  return null;
}

export function lfgOfflineBoundaries(main: RequestRow[], cwd: string | null): LfgBoundary[] {
  const out: LfgBoundary[] = [];
  for (const row of main) {
    for (const call of row.toolCalls) {
      if (call.name !== 'Bash') continue;
      const command = inputString(call.input, 'command');
      if (command === null || !WF_OBSIDIAN.test(command) || NOT_A_WRITE.test(command)) continue;
      const stage = boundaryStage(command);
      if (stage === null || call.isError || call.result === null) continue;
      const printed = WRITTEN_PATH.exec(call.result)?.[0].trim();
      if (printed === undefined) continue;
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
  return out;
}
