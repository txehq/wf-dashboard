import { config } from '../../src/config.js';
import type { Db } from '../../src/db/index.js';
import { batches, runs, sessions, variants } from '../../src/db/schema.js';
import type { CrossRunRef } from '../../src/grading/schema.js';
import { initialParseState } from '../../src/ingest/ingest.js';

// The variant belongs to workflowId (the built-in lfg by default); ic runs use an ic variant (Contracts 16.4)
export function insertVariant(db: Db, id: string, workflowId = 'lfg') {
  db.insert(variants)
    .values({
      id,
      name: id,
      workflowId,
      baseCommit: '9f2bed6',
      skillsHash: id.padEnd(64, '0'),
      version: `2.3.0-eval.${id}`,
      status: 'frozen',
    })
    .run();
}

export interface RunSeed {
  id: string;
  taskId: string;
  variantId: string;
  status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  humanIntervened?: boolean;
  crossRunRefs?: CrossRunRef[];
  startedAt?: Date;
  githubRepo?: string | null;
  createdAt?: Date;
  model?: string;
}

let repeat = 0;

// A run and its session row; the batch is created from the run id
export function insertRun(db: Db, seed: RunSeed) {
  const sessionId = `session-${seed.id}`;
  const startedAt = seed.startedAt ?? new Date('2026-10-09T08:00:00Z');
  db.insert(batches)
    .values({ id: `batch-${seed.id}`, repeats: 1 })
    .run();
  db.insert(runs)
    .values({
      id: seed.id,
      batchId: `batch-${seed.id}`,
      taskId: seed.taskId,
      variantId: seed.variantId,
      repeatIndex: repeat++,
      model: seed.model ?? 'opus',
      effort: 'high',
      status: seed.status ?? 'running',
      humanIntervened: seed.humanIntervened ?? false,
      crossRunRefs: seed.crossRunRefs ?? [],
      sessionId,
      workspacePath: `${config.runsDir}/${seed.id}/workspace`,
      githubRepo: seed.githubRepo ?? null,
      startedAt,
      ...(seed.createdAt === undefined ? {} : { createdAt: seed.createdAt }),
    })
    .run();
  db.insert(sessions)
    .values({
      id: sessionId,
      runId: seed.id,
      filePath: `/runs/${seed.id}/${sessionId}.jsonl`,
      startedAt,
      endedAt: startedAt,
      parseState: initialParseState(),
    })
    .run();
  return sessionId;
}
