import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toString } from 'mdast-util-to-string';
import type { RubricArtifactSpec } from '../workflows/schema.js';

// Artifacts for rubric grading (Contracts 7.2, 16.2): files wf obsidian writes into the feature directory and the
// snapshot after the plan is locked; they take no part in the stage partition

// Same as wf obsidian's slugify
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

// The escapes also match the Chinese heading ("plan", "implementation plan"), status word and full-width colon of
// vault documents written before Contracts 36
const PLAN_HEADING =
  /^(?:\d+\.\s*)?(?:plan|\u{8BA1}\u{5212}|\u{5B9E}\u{65BD}\u{8BA1}\u{5212})(?![a-z])/iu;
const LOCKED_STATUS = /^(?:status|\u{72B6}\u{6001})\s*[:\u{FF1A}]\s*locked\b/iu;

// The lock status line in the Plan section of the body (without frontmatter); null when there is none
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
    // null without frontmatter or a field: not an artifact wf obsidian wrote, so the comparisons below fail
    kind: typeof fm.kind === 'string' ? fm.kind : null,
    feature: typeof fm.feature === 'string' ? fm.feature : null,
    hash: createHash('sha256').update(raw).digest('hex'),
    planLockLine: planLockedLine(content),
  };
}

// The artifact's candidate files whose frontmatter kind matches and whose feature is the run id, in candidate order;
// null for missing ones
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

// Artifacts in the feature directory during a live run: each observe() reads the directory once and returns the
// current file of each artifact id. A lockedPlan artifact needs the lock marker to appear in a rewrite after the
// file first appeared, so the hash of each candidate file when first seen is remembered
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
