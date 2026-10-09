import { EventEmitter } from 'node:events';
import type { Workflow } from './db/schema.js';

// 进程内事件；runs 模块在第 2 波追加 run.* 事件
export type AppEvent =
  | { type: 'session.updated'; sessionId: string }
  | {
      type: 'stage.changed';
      sessionId: string;
      workflow: Workflow;
      stage: string;
      status: 'done' | 'active' | 'skipped' | 'not-reached';
    };

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
