import { events, type AppEvent } from '../../src/events.js';

type Progress = Extract<AppEvent, { type: 'stage.progress' }>;

// 订阅一个 session 的判定事件：progress 依次记录收到的 stage.progress；
// done 在 stage.analyzed 时完成，在 stage.failed 时以错误原文失败
export function watchAnalysis(sessionId: string) {
  const progress: Progress[] = [];
  let stop: () => void = () => undefined;
  const done = new Promise<undefined>((resolve, reject) => {
    stop = events.subscribe((e) => {
      if (!('sessionId' in e) || e.sessionId !== sessionId) return;
      if (e.type === 'stage.progress') progress.push(e);
      if (e.type === 'stage.analyzed') {
        stop();
        resolve(undefined);
      }
      if (e.type === 'stage.failed') {
        stop();
        reject(new Error(e.error));
      }
    });
  });
  return {
    progress,
    done,
    stop: () => {
      stop();
    },
  };
}
