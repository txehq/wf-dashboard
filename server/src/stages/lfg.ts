import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toString } from 'mdast-util-to-string';

// lfg 的产物记录（Contracts 7.2）：feature 目录中的 Brief、Research、Tickets 与 plan 锁定后的快照，不参与阶段划分

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

export interface LfgArtifactDocs {
  brief: LfgDoc | null;
  research: LfgDoc | null;
  // 锁定了 Plan 一节的 Research.md 或 System Design.md
  plan: LfgDoc | null;
  tickets: LfgDoc | null;
}

// 实时运行中 feature 目录的产物：每次 observe() 读一次目录。
// plan 锁定要求锁定标记出现在文件首次出现之后的某次改写中，因此记住每个主文档首次被看到时的 hash。
export class LfgTracker {
  private readonly firstHash = new Map<string, string>();

  constructor(
    readonly dir: string,
    readonly feature: string,
  ) {}

  observe(): LfgArtifactDocs {
    const docs = lfgSnapshot(this.dir, this.feature);
    let plan: LfgDoc | null = null;
    for (const doc of [docs.research, docs.design]) {
      if (!doc) continue;
      const first = this.firstHash.get(doc.path);
      if (first === undefined) this.firstHash.set(doc.path, doc.hash);
      else if (!plan && doc.planLockLine !== null && doc.hash !== first) plan = doc;
    }
    return {
      brief: docs.brief,
      research: docs.research ?? docs.design,
      plan,
      tickets: docs.tickets,
    };
  }
}
