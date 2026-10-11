import { EventEmitter } from 'node:events';
import type { RunStatus, StageStatus, Workflow } from './db/schema.js';
import type { ArtifactView, Pending, RunMessageView } from './runs/views.js';

// 进程内事件；run.* 由 runs 模块发布（Contracts 7.6）
export type AppEvent =
  | { type: 'session.updated'; sessionId: string }
  | {
      type: 'stage.changed';
      sessionId: string;
      workflow: Workflow;
      stage: string;
      status: StageStatus;
    }
  // step 为正在执行的构建步骤；构建开始、完成与失败时为 null
  | {
      type: 'variant.build';
      variantId: string;
      status: 'building' | 'built' | 'failed';
      step: string | null;
    }
  | { type: 'run.status'; runId: string; status: RunStatus }
  | { type: 'run.message'; runId: string; message: RunMessageView }
  | { type: 'run.pending'; runId: string; pending: Pending | null }
  | {
      type: 'run.stage';
      runId: string;
      workflow: Workflow;
      stage: string;
      status: StageStatus;
    }
  | { type: 'run.artifact'; runId: string; artifact: ArtifactView }
  | { type: 'run.cost'; runId: string; costUsd: number };

const emitter = new EventEmitter();
// 每个 SSE 连接一个监听者
emitter.setMaxListeners(0);

export const events = {
  publish(event: AppEvent) {
    emitter.emit('event', event);
  },
  // 返回取消订阅的函数
  subscribe(listener: (event: AppEvent) => void) {
    emitter.on('event', listener);
    return () => {
      emitter.off('event', listener);
    };
  },
};
