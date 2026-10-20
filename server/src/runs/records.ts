import { and, asc, eq, max } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  type ArtifactKind,
  artifacts,
  type RunMessagePayload,
  type RunMessageRole,
  runMessages,
} from '../db/schema.js';
import { events } from '../events.js';
import type { ArtifactView, RunMessageView } from './views.js';

type MessageRow = typeof runMessages.$inferSelect;
type ArtifactRow = typeof artifacts.$inferSelect;

export const messageView = (m: MessageRow): RunMessageView => ({
  id: m.id,
  seq: m.seq,
  role: m.role,
  content: m.content,
  costUsd: m.costUsd,
  payload: m.payload ?? null,
  createdAt: m.createdAt.getTime(),
});

export const artifactView = (a: ArtifactRow): ArtifactView => ({
  kind: a.kind,
  location: a.location,
  snapshot: a.snapshot,
  createdAt: a.createdAt.getTime(),
  updatedAt: a.updatedAt.getTime(),
});

export function addMessage(
  db: Db,
  runId: string,
  message: {
    role: RunMessageRole;
    content: string;
    costUsd?: number;
    payload?: RunMessagePayload;
  },
): RunMessageView {
  const row = db.transaction((tx) => {
    const last = tx
      .select({ seq: max(runMessages.seq) })
      .from(runMessages)
      .where(eq(runMessages.runId, runId))
      .get();
    return tx
      .insert(runMessages)
      .values({
        runId,
        seq: (last?.seq ?? -1) + 1,
        role: message.role,
        content: message.content,
        costUsd: message.costUsd ?? 0,
        payload: message.payload ?? null,
      })
      .returning()
      .get();
  });
  const view = messageView(row);
  events.publish({ type: 'run.message', runId, message: view });
  return view;
}

export function listMessages(db: Db, runId: string): MessageRow[] {
  return db
    .select()
    .from(runMessages)
    .where(eq(runMessages.runId, runId))
    .orderBy(asc(runMessages.seq))
    .all();
}

// 每个 run 每种产物一行（friction 除外）；内容与位置都没变时不改写
export function upsertArtifact(
  db: Db,
  runId: string,
  kind: Exclude<ArtifactKind, 'friction'>,
  location: string,
  snapshot: string | null,
) {
  const existing = db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.runId, runId), eq(artifacts.kind, kind)))
    .get();
  if (existing?.location === location && existing.snapshot === snapshot) return;
  const now = new Date();
  const row =
    existing === undefined
      ? db
          .insert(artifacts)
          .values({ runId, kind, location, snapshot, updatedAt: now })
          .returning()
          .get()
      : db
          .update(artifacts)
          .set({ location, snapshot, updatedAt: now })
          .where(eq(artifacts.id, existing.id))
          .returning()
          .get();
  events.publish({ type: 'run.artifact', runId, artifact: artifactView(row) });
}

// friction：每个 issue 或评论 URL 一行，snapshot 为 issue 标题
export function upsertFriction(db: Db, runId: string, url: string, title: string) {
  const row = db
    .insert(artifacts)
    .values({ runId, kind: 'friction', location: url, snapshot: title, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [artifacts.runId, artifacts.kind, artifacts.location],
      set: { snapshot: title, updatedAt: new Date() },
    })
    .returning()
    .get();
  events.publish({ type: 'run.artifact', runId, artifact: artifactView(row) });
}
