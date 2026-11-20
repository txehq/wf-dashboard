import type { PaidCheckId } from './db/schema.js';

// Real use of a paid environment check (Contracts 8): every real simulated user reply, judge call and Codex call
// reports its outcome here; the environment records it into its check. Scripts outside the server register no
// listener and report nothing
export interface PaidUsage {
  ok: boolean;
  // On success, what answered; on failure, the original error text
  detail: string;
}

let listener: ((id: PaidCheckId, usage: PaidUsage) => void) | undefined;

export function onPaidUsage(next: (id: PaidCheckId, usage: PaidUsage) => void) {
  listener = next;
}

export function reportPaidUsage(id: PaidCheckId, usage: PaidUsage) {
  listener?.(id, usage);
}
