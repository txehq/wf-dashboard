import fs from 'node:fs';
import path from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { artifacts, fixedArtifactKinds, liveEvents, liveSessions, runs } from '../db/schema.js';
import { featureDir } from '../stages/artifacts.js';
import { issueIdentifier } from '../tasks/import-schema.js';

// Session 详情的"绑定的对象"（Contracts 18.2）：run 的产物（仓库、工单、PR、vault 产物）与 isolated 交互项的
// 副本仓库、工单副本、vault 目录
export const SessionLinks = z.object({
  github: z.array(z.object({ label: z.string(), url: z.string() })),
  linear: z.array(z.object({ label: z.string(), url: z.string() })),
  obsidian: z.array(z.object({ label: z.string(), path: z.string() })),
});
export type SessionLinks = z.infer<typeof SessionLinks>;

// 本地仓库模式的仓库是本机路径，不是 GitHub 网页
const GITHUB = /^https:\/\/github\.com\/([^/]+\/[^/]+)(?:\/pull\/(\d+))?\/?$/;
const fixedKinds = new Set<string>(fixedArtifactKinds);

// 交互项 start 事件中 isolated 环境建出的副本（Contracts 14.2）
const StartPayload = z.looseObject({
  repoUrl: z.string().optional(),
  ticketUrl: z.string().optional(),
});

export interface VaultLocation {
  dir: string;
  product: string;
}

export function sessionLinks(
  db: Db,
  session: { id: string; runId: string | null; liveId: string | null },
  vault: VaultLocation,
): SessionLinks {
  const github = new Map<string, string>();
  const linear = new Map<string, string>();
  const obsidian = new Set<string>();
  const addUrl = (url: string) => {
    const gh = GITHUB.exec(url);
    if (gh?.[1] !== undefined) {
      github.set(url, gh[2] === undefined ? gh[1] : `${gh[1]}#${gh[2]}`);
      return;
    }
    const identifier = issueIdentifier(url);
    if (identifier !== null && url.startsWith('https://')) linear.set(url, identifier);
  };

  const run = db
    .select({ id: runs.id })
    .from(runs)
    .where(session.runId === null ? eq(runs.sessionId, session.id) : eq(runs.id, session.runId))
    .get();
  if (run !== undefined) {
    const rows = db
      .select({ kind: artifacts.kind, location: artifacts.location })
      .from(artifacts)
      .where(eq(artifacts.runId, run.id))
      .orderBy(asc(artifacts.id))
      .all();
    for (const { kind, location } of rows) {
      if (kind === 'repo' || kind === 'pr' || kind === 'ticket') addUrl(location);
      // rubric 产物是 feature 目录中的文档
      else if (!fixedKinds.has(kind) && path.isAbsolute(location)) obsidian.add(location);
    }
  }

  if (session.liveId !== null) {
    const item = db
      .select({ environment: liveSessions.environment })
      .from(liveSessions)
      .where(eq(liveSessions.id, session.liveId))
      .get();
    if (item?.environment === 'isolated') {
      const start = db
        .select({ payload: liveEvents.payload })
        .from(liveEvents)
        .where(and(eq(liveEvents.liveId, session.liveId), eq(liveEvents.kind, 'start')))
        .orderBy(asc(liveEvents.id))
        .get();
      const payload = StartPayload.parse(start?.payload ?? {});
      if (payload.repoUrl !== undefined) addUrl(payload.repoUrl);
      if (payload.ticketUrl !== undefined) addUrl(payload.ticketUrl);
      const dir = featureDir(vault.dir, vault.product, session.liveId);
      if (fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
        for (const name of fs.readdirSync(dir).sort()) {
          if (name.endsWith('.md')) obsidian.add(path.join(dir, name));
        }
      }
    }
  }

  // 仓库排在它的 PR 之前
  return {
    github: [...github]
      .map(([url, label]) => ({ label, url }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    linear: [...linear].map(([url, label]) => ({ label, url })),
    obsidian: [...obsidian].map((p) => ({ label: path.basename(p), path: p })),
  };
}
