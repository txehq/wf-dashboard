import { EventEmitter } from 'node:events';
import type { AnalysisStatus, DraftStatus, RunStatus, StageStatus } from './db/schema.js';
import type { ArtifactView, Pending, RunMessageView } from './runs/views.js';

// 进程内事件；run.* 由 runs 模块发布（Contracts 7.6）；workflow 为 workflow id（Contracts 16.6）
export type AppEvent =
  | { type: 'session.updated'; sessionId: string }
  | {
      type: 'stage.changed';
      sessionId: string;
      workflow: string;
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
  // variant 改了名字、被覆盖或恢复（Contracts 16.4、17.4）；各处都按 id 取名字，页面重新读取
  | { type: 'variant.updated'; variantId: string }
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
  // 交互 session 的状态、驾驶者、等待的输入或 hook 有变化（Contracts 14），页面重新读取详情
  | { type: 'live.updated'; liveId: string }
  // Codex 草稿的状态或准备的进度变化（Contracts 17.1）
  | { type: 'draft.updated'; draftId: string; status: DraftStatus }
  // 分析的状态或步骤进度变化（Contracts 15.2）
  | { type: 'analysis.updated'; analysisId: string; status: AnalysisStatus };

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
