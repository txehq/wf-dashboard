import { and, eq, isNull } from 'drizzle-orm';
import { execa } from 'execa';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { variants as variantsTable, workflowReleases } from '../db/schema.js';
import { events } from '../events.js';
import { type GhResult, ghResult } from '../external/github.js';
import { type EvalKind, type ReleaseView, WF_WORKFLOWS } from '../workflows/schema.js';
import type { Variants } from './index.js';

// lfg and ic come with a variant of the latest txe-workflow release by default (Contracts 29.1)

export const RELEASE_REPO = 'txehq/txe-workflow';
export const RELEASE_CHECK_MS = 6 * 60 * 60 * 1000;

// Without a tag, reads the release marked Latest on GitHub
export const releaseArgs = (repo: string, tag: string | null) => [
  'release',
  'view',
  ...(tag === null ? [] : [tag]),
  '--repo',
  repo,
  '--json',
  'tagName,publishedAt',
];

const ReleaseJson = z.object({ tagName: z.string().min(1), publishedAt: z.iso.datetime() });

export interface Release {
  tag: string;
  publishedAt: Date;
}

// A non-zero gh exit fails with its stderr
export function releaseFrom(args: string[], result: GhResult): Release {
  if (result.exitCode !== 0) {
    throw new Error(
      `gh ${args.join(' ')} exited with code ${String(result.exitCode)}: ${result.stderr.trim()}`,
    );
  }
  const json = ReleaseJson.parse(JSON.parse(result.stdout));
  return { tag: json.tagName, publishedAt: new Date(json.publishedAt) };
}

export interface ReleaseRead {
  args: string[];
  result: GhResult;
}

const latestArgs = releaseArgs(RELEASE_REPO, null);
const readLatestRelease = async (): Promise<ReleaseRead> => ({
  args: latestArgs,
  result: await ghResult(latestArgs),
});

// The tag's commit: when the tag is missing locally, fetch only that tag first (working tree and branches untouched)
export async function releaseCommit(repo: string, tag: string): Promise<string> {
  const ref = `refs/tags/${tag}^{commit}`;
  const local = await execa('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', ref], {
    reject: false,
  });
  if (local.exitCode === 0) return local.stdout.trim();
  await execa('git', ['-C', repo, 'fetch', 'origin', 'tag', tag, '--no-tags']);
  const { stdout } = await execa('git', ['-C', repo, 'rev-parse', '--verify', ref]);
  return stdout.trim();
}

export const releaseVariantName = (tag: string) => `txe-workflow ${tag}`;

// The variant auto-imported for a tag, deleted ones included: once deleted it is not recreated
function releaseVariant(db: Db, workflowId: EvalKind, tag: string) {
  return db
    .select()
    .from(variantsTable)
    .where(and(eq(variantsTable.workflowId, workflowId), eq(variantsTable.releaseTag, tag)))
    .get();
}

// The release of GET /api/workflows/:id; null for workflows other than lfg and ic, or before the first check
export function releaseView(db: Db, workflowId: string): ReleaseView | null {
  const row = db
    .select()
    .from(workflowReleases)
    .where(eq(workflowReleases.workflowId, workflowId))
    .get();
  if (row === undefined) return null;
  const variant =
    row.tag === null
      ? undefined
      : db
          .select({ id: variantsTable.id })
          .from(variantsTable)
          .where(
            and(
              eq(variantsTable.workflowId, workflowId),
              eq(variantsTable.releaseTag, row.tag),
              isNull(variantsTable.deletedAt),
            ),
          )
          .get();
  return {
    tag: row.tag,
    publishedAt: row.publishedAt?.getTime() ?? null,
    checkedAt: row.checkedAt.getTime(),
    variantId: variant?.id ?? null,
    error: row.error,
  };
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface ReleaseCheckOptions {
  db: Db;
  variants: Variants;
  // The txe-workflow repo (config.txeWorkflowRepo)
  repo: string;
  // gh release view arguments and result; tests pass recorded real output
  readRelease?: (() => Promise<ReleaseRead>) | undefined;
}

export function createReleaseCheck({
  db,
  variants,
  repo,
  readRelease = readLatestRelease,
}: ReleaseCheckOptions) {
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  // Changes only the given fields; tag and publishedAt keep the last values read
  function record(
    workflowId: EvalKind,
    values: { checkedAt: Date; error: string | null; release?: Release | undefined },
  ) {
    const set = {
      checkedAt: values.checkedAt,
      error: values.error,
      ...(values.release === undefined
        ? {}
        : { tag: values.release.tag, publishedAt: values.release.publishedAt }),
    };
    db.insert(workflowReleases)
      .values({ workflowId, ...set })
      .onConflictDoUpdate({ target: workflowReleases.workflowId, set })
      .run();
    events.publish({ type: 'workflow.release', workflowId });
  }

  // Without a variant for this tag, create one as an imported baseline; one imported but never built successfully (e.g. a build cut off by a restart) is built as usual
  async function ensureVariant(workflowId: EvalKind, release: Release, commit: string) {
    const existing = releaseVariant(db, workflowId, release.tag);
    if (existing !== undefined && existing.deletedAt !== null) return;
    const row =
      existing ??
      (await variants.createBaseline({
        name: releaseVariantName(release.tag),
        commit,
        workflowId,
        description: `txe-workflow ${release.tag} release, auto-imported`,
        releaseTag: release.tag,
      }));
    if (existing === undefined) events.publish({ type: 'workflow.release', workflowId });
    if (row.builtHash === null && row.buildStatus !== 'building') await variants.build(row.id);
  }

  async function run() {
    const checkedAt = new Date();
    let release: Release | undefined;
    let commit: string;
    // A background check failure is recorded verbatim and shown through release.error; the server keeps running
    try {
      const read = await readRelease();
      release = releaseFrom(read.args, read.result);
      commit = await releaseCommit(repo, release.tag);
    } catch (error) {
      console.error('[release] Checking the latest txe-workflow release failed', error);
      for (const id of WF_WORKFLOWS) record(id, { checkedAt, error: messageOf(error), release });
      return;
    }
    for (const id of WF_WORKFLOWS) {
      record(id, { checkedAt, error: null, release });
      try {
        await ensureVariant(id, release, commit);
      } catch (error) {
        console.error(`[release] ${id}: importing or building ${release.tag} failed`, error);
        record(id, { checkedAt, error: messageOf(error) });
      }
    }
  }

  return {
    // One check; returns the previous one while it is still running
    check(): Promise<void> {
      running ??= run().finally(() => {
        running = null;
      });
      return running;
    },

    // Starts once the server listens: one check at once, then every 6 hours, all in the background
    start(intervalMs = RELEASE_CHECK_MS) {
      void this.check();
      timer = setInterval(() => {
        void this.check();
      }, intervalMs);
    },

    // Stops the timer on server close; an in-flight build ends with the server process, variants marks it interrupted on next start and the check rebuilds it
    stop() {
      clearInterval(timer);
    },
  };
}

export type ReleaseCheck = ReturnType<typeof createReleaseCheck>;
