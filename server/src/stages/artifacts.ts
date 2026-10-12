import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toString } from 'mdast-util-to-string';
import type { RubricArtifactSpec } from '../workflows/schema.js';

// rubric 评分的产物（Contracts 7.2、16.2）：feature 目录中由 wf obsidian 写出的文件与 plan 锁定后的快照，不参与阶段划分

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

export interface FeatureDoc {
  path: string;
  kind: string | null;
  feature: string | null;
  hash: string;
  planLockLine: string | null;
}

export function readDoc(file: string): FeatureDoc | null {
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

// 产物的候选文件中 frontmatter 的 kind 相符、feature 为 run id 的那些，按候选顺序；不存在的为 null
export function candidateDocs(
  dir: string,
  feature: string,
  spec: RubricArtifactSpec,
): (FeatureDoc | null)[] {
  return spec.files.map(({ file, kind }) => {
    const doc = readDoc(path.join(dir, file));
    return doc?.kind === kind && doc.feature === feature ? doc : null;
  });
}

// 实时运行中 feature 目录的产物：每次 observe() 读一次目录，返回每个产物 id 当前的文件。
// lockedPlan 的产物要求锁定标记出现在文件首次出现之后的某次改写中，因此记住每个候选文件首次被看到时的 hash
export class ArtifactTracker {
  private readonly firstHash = new Map<string, string>();

  constructor(
    readonly dir: string,
    readonly feature: string,
    readonly specs: RubricArtifactSpec[],
  ) {}

  observe(): Map<string, FeatureDoc | null> {
    const out = new Map<string, FeatureDoc | null>();
    for (const spec of this.specs) {
      const docs = candidateDocs(this.dir, this.feature, spec);
      if (spec.lockedPlan !== true) {
        out.set(spec.id, docs.find((d) => d !== null) ?? null);
        continue;
      }
      let locked: FeatureDoc | null = null;
      for (const doc of docs) {
        if (!doc) continue;
        const first = this.firstHash.get(doc.path);
        if (first === undefined) this.firstHash.set(doc.path, doc.hash);
        else if (!locked && doc.planLockLine !== null && doc.hash !== first) locked = doc;
      }
      out.set(spec.id, locked);
    }
    return out;
  }
}
