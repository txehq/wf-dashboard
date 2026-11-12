import { EventEmitter } from 'node:events';
import type {
  AnalysisStatus,
  DraftStatus,
  MagiDeployStatus,
  RunStatus,
  StageStatus,
  TeamSyncProgress,
  TeamSyncStatus,
} from './db/schema.js';
import type { ArtifactView, Pending, RunMessageView } from './runs/views.js';

// In-process events; run.* are published by the runs module (Contracts 7.6); workflow is the workflow id (Contracts 16.6)
export type AppEvent =
  | { type: 'session.updated'; sessionId: string }
  | {
      type: 'stage.changed';
      sessionId: string;
      workflow: string;
      stage: string;
      status: StageStatus;
    }
  // step is the build step in progress; null when the build starts, finishes or fails
  | {
      type: 'variant.build';
      variantId: string;
      status: 'building' | 'built' | 'failed';
      step: string | null;
    }
  // A variant was renamed, overwritten or restored (Contracts 16.4, 17.4); names are looked up by id, pages reload
  | { type: 'variant.updated'; variantId: string }
  // After a variant or workflow is deleted (Contracts 24.6), open pages reload
  | { type: 'variant.deleted'; variantId: string }
  | { type: 'workflow.deleted'; workflowId: string }
  // The txe-workflow latest-release check for lfg or ic changed or auto-imported a variant (Contracts 29.1); pages reload workflows and variants
  | { type: 'workflow.release'; workflowId: string }
  | { type: 'run.status'; runId: string; status: RunStatus }
  | { type: 'run.message'; runId: string; message: RunMessageView }
  | { type: 'run.pending'; runId: string; pending: Pending | null }
  | {
      type: 'run.stage';
      runId: string;
      workflow: string;
      stage: string;
      status: StageStatus;
    }
  | { type: 'run.artifact'; runId: string; artifact: ArtifactView }
  | { type: 'run.cost'; runId: string; costUsd: number }
  // An interactive session's status, driver, awaited input or hooks changed (Contracts 14); pages reload the details
  | { type: 'live.updated'; liveId: string }
  // Orca's orchestration topology changed (Contracts 35.3); pages reload /api/live/orca
  | { type: 'orca.updated' }
  // A Codex draft's status or preparation progress changed (Contracts 17.1)
  | { type: 'draft.updated'; draftId: string; status: DraftStatus }
  // An analysis's status or step progress changed (Contracts 15.2)
  | { type: 'analysis.updated'; analysisId: string; status: AnalysisStatus }
  // Magi Agent worktree preparation progress or current session changed (Contracts 23.1, 23.2); pages reload /api/magi-agent
  | { type: 'magi.updated' }
  // Each deploy step starts and ends (Contracts 23.5)
  | { type: 'magi.deploy'; deployId: number; status: MagiDeployStatus }
  // The self-update of an installed package changed step, found a version, waits or failed (Contracts 39.4); pages
  // reload /api/install
  | { type: 'install.updated' }
  // An SSH host was added, renamed, checked or deleted (Contracts 31.1); pages reload /api/ssh-hosts
  | { type: 'ssh-hosts.updated' }
  // Linear stats sync progress and its end (Contracts 37.2); pages reload /api/team/* when it ends
  | {
      type: 'team.sync';
      syncId: number;
      status: TeamSyncStatus;
      progress: TeamSyncProgress;
    };

const emitter = new EventEmitter();
// One listener per SSE connection
emitter.setMaxListeners(0);

export const events = {
  publish(event: AppEvent) {
    emitter.emit('event', event);
  },
  // Returns the unsubscribe function
  subscribe(listener: (event: AppEvent) => void) {
    emitter.on('event', listener);
    return () => {
      emitter.off('event', listener);
    };
  },
  // Current subscriber count (GET /api/diagnostics)
  subscribers() {
    return emitter.listenerCount('event');
  },
};
