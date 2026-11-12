import { isType, type StreamEvent } from './stream.js';

// Turn states (Spikes/Claude CLI section 8):
// running             - a user message was written or a background notification woke the agent; no result yet
// awaiting_host       - an unanswered control_request (AskUserQuestion or a permission request)
// awaiting_background - result seen but background tasks remain; the agent starts the next turn on its own when they finish
// idle                - result seen and no background tasks: waiting for user input
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

  // Called when the host writes a user message
  userSent(): void {
    this.resultSeen = false;
    this.set('running', 'user message');
  }

  // Called when the host answers a control_request
  controlAnswered(requestId: string): void {
    if (!this.pendingControl.delete(requestId)) {
      throw new Error(`Answered a control_request that does not exist: ${requestId}`);
    }
    if (this.pendingControl.size > 0) return;
    // If the turn already ended before the answer (e.g. after an interrupt), return to the settled state
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
      // After a background task finishes the agent is woken to start a new turn
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
