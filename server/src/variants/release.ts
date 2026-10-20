import { and, eq, isNull } from 'drizzle-orm';
import { execa } from 'execa';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { variants as variantsTable, workflowReleases } from '../db/schema.js';
import { events } from '../events.js';
import { type GhResult, ghResult } from '../external/github.js';
import { type EvalKind, type ReleaseView, WF_WORKFLOWS } from '../workflows/schema.js';
import type { Variants } from './index.js';

// lfg、ic 默认带 txe-workflow 最新版的 variant（Contracts 29.1）

export const RELEASE_REPO = 'txehq/txe-workflow';
export const RELEASE_CHECK_MS = 6 * 60 * 60 * 1000;

// tag 为空时读 GitHub 上标为 Latest 的 release
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

// gh 非零退出时以它的 stderr 原文失败
export function releaseFrom(args: string[], result: GhResult): Release {
  if (result.exitCode !== 0) {
    throw new Error(
      `gh ${args.join(' ')} 退出码 ${String(result.exitCode)}：${result.stderr.trim()}`,
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

// tag 的 commit：本地没有这个 tag 时先只 fetch 这一个 tag（不改工作区与分支）
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

// 某个 tag 自动导入的 variant，包括已删除的：删除后不再建回
function releaseVariant(db: Db, workflowId: EvalKind, tag: string) {
  return db
    .select()
    .from(variantsTable)
    .where(and(eq(variantsTable.workflowId, workflowId), eq(variantsTable.releaseTag, tag)))
    .get();
}

// GET /api/workflows/:id 的 release；不是 lfg、ic 或还没有检查过时为空
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
  // txe-workflow 仓库（config.txeWorkflowRepo）
  repo: string;
  // gh release view 的参数与结果；测试传入录下的真实输出
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

  // 只改给出的字段；tag 与 publishedAt 保留上次读到的
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

  // 还没有这个 tag 的 variant 时按导入基线建一个；导入后还没有构建成功过的（例如构建被服务重启中断）照常构建
  async function ensureVariant(workflowId: EvalKind, release: Release, commit: string) {
    const existing = releaseVariant(db, workflowId, release.tag);
    if (existing !== undefined && existing.deletedAt !== null) return;
    const row =
      existing ??
      (await variants.createBaseline({
        name: releaseVariantName(release.tag),
        commit,
        workflowId,
        description: `txe-workflow ${release.tag} release，自动导入`,
        releaseTag: release.tag,
      }));
    if (existing === undefined) events.publish({ type: 'workflow.release', workflowId });
    if (row.builtHash === null && row.buildStatus !== 'building') await variants.build(row.id);
  }

  async function run() {
    const checkedAt = new Date();
    let release: Release | undefined;
    let commit: string;
    // 后台检查的失败记为原文，经 release.error 显示，服务照常运行
    try {
      const read = await readRelease();
      release = releaseFrom(read.args, read.result);
      commit = await releaseCommit(repo, release.tag);
    } catch (error) {
      console.error('[release] 检查 txe-workflow 最新版失败', error);
      for (const id of WF_WORKFLOWS) record(id, { checkedAt, error: messageOf(error), release });
      return;
    }
    for (const id of WF_WORKFLOWS) {
      record(id, { checkedAt, error: null, release });
      try {
        await ensureVariant(id, release, commit);
      } catch (error) {
        console.error(`[release] ${id} 导入或构建 ${release.tag} 失败`, error);
        record(id, { checkedAt, error: messageOf(error) });
      }
    }
  }

  return {
    // 一次检查；上一次还没结束时返回它
    check(): Promise<void> {
      running ??= run().finally(() => {
        running = null;
      });
      return running;
    },

    // 服务监听后开始：立即检查一次，之后每 6 小时一次，都在后台进行
    start(intervalMs = RELEASE_CHECK_MS) {
      void this.check();
      timer = setInterval(() => {
        void this.check();
      }, intervalMs);
    },

    // 关闭服务时停止定时检查；进行中的构建随服务进程结束，下次启动时 variants 把它标为中断，检查时重新构建
    stop() {
      clearInterval(timer);
    },
  };
}

export type ReleaseCheck = ReturnType<typeof createReleaseCheck>;
