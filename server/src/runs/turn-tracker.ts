import { isType, type StreamEvent } from './stream.js';

// 一轮的状态（Spikes/Claude CLI 第 8 节）：
// running             —— 用户消息已写入或 agent 被后台通知唤起，尚未出现 result
// awaiting_host       —— 有未回答的 control_request（AskUserQuestion 或权限请求）
// awaiting_background —— 已出现 result，但仍有后台任务，完成后 agent 会自行开始下一轮
// idle                —— 已出现 result 且没有后台任务：等待用户输入
export type TurnState = 'running' | 'awaiting_host' | 'awaiting_background' | 'idle';

export interface TurnTransition {
  state: TurnState;
  cause: string;
}

export class TurnTracker {
  state: TurnState = 'idle';
  readonly transitions: TurnTransition[] = [];
  private backgroundTasks = 0;
  private readonly pendingControl = new Set<string>();
  private resultSeen = false;

  constructor(private readonly onChange: (t: TurnTransition) => void = () => undefined) {}

  // 宿主写入用户消息时调用
  userSent(): void {
    this.resultSeen = false;
    this.set('running', 'user message');
  }

  // 宿主回答 control_request 时调用
  controlAnswered(requestId: string): void {
    if (!this.pendingControl.delete(requestId)) {
      throw new Error(`回答了不存在的 control_request：${requestId}`);
    }
    if (this.pendingControl.size > 0) return;
    // 回答之前一轮已经结束（例如中断后）时直接回到结束状态
    if (this.resultSeen) this.settle('control_response');
    else this.set('running', 'control_response');
  }

  observe(e: StreamEvent): void {
    if (isType(e, 'control_request')) {
      this.pendingControl.add(e.request_id);
      this.set(
        'awaiting_host',
        `control_request ${e.request.subtype}:${e.request.tool_name ?? ''}`,
      );
    } else if (isType(e, 'system') && e.subtype === 'background_tasks_changed') {
      this.backgroundTasks = e.tasks?.length ?? 0;
      if (this.resultSeen) this.settle('background_tasks_changed');
    } else if (isType(e, 'system') && e.subtype === 'task_notification') {
      // 后台任务完成后 agent 会被唤起开始新的一轮
      if (this.resultSeen) {
        this.resultSeen = false;
        this.set('running', 'task_notification');
      }
    } else if (isType(e, 'result')) {
      this.resultSeen = true;
      this.settle(`result/${e.subtype}`);
    }
  }

  get hasPendingControl(): boolean {
    return this.pendingControl.size > 0;
  }

  private settle(cause: string): void {
    if (this.pendingControl.size > 0) return;
    this.set(this.backgroundTasks > 0 ? 'awaiting_background' : 'idle', cause);
  }

  private set(state: TurnState, cause: string): void {
    if (state === this.state && this.transitions.length > 0) return;
    this.state = state;
    const t = { state, cause };
    this.transitions.push(t);
    this.onChange(t);
  }
}
