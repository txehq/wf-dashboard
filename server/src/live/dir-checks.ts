import { isDirectory } from '../dirs/exists.js';

// Whether the Orca page's working directories on this machine exist (Contracts 40.2, W139). The graph never waits on
// a check: it reads the latest answer, and a directory without one counts as unknown. Each sync re-checks every
// directory the graph asked about since the previous sync and waits up to waitMs; one still pending then counts as
// unknown for that sync and is reported. A check that settles with a new answer tells the page (changed), so a node
// left out while its directory was being checked appears as soon as the check finishes

// Checks running at once: each holds a libuv thread while its path is blocked
const CONCURRENT = 8;
const NOTIFY_MS = 100;

export function createDirChecks(deps: { waitMs: number; changed: () => void }) {
  const known = new Map<string, boolean>();
  // A directory with a check running or queued; a blocked path gets no second check
  const pending = new Map<string, Promise<void>>();
  const queue: (() => void)[] = [];
  let active = 0;
  // Directories the graph asked about since the previous sync
  let asked = new Set<string>();
  // Why a directory has no answer: the original text of the error its last check failed with
  const failures = new Map<string, string>();
  // Pending checks already reported as slow
  const slow = new Set<string>();
  let notify: NodeJS.Timeout | null = null;

  async function slot(): Promise<void> {
    if (active < CONCURRENT) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => queue.push(resolve));
  }

  function release() {
    const next = queue.shift();
    if (next === undefined) active -= 1;
    else next();
  }

  function settle(dir: string, answer: boolean | null) {
    const before = known.get(dir) ?? null;
    if (answer === null) known.delete(dir);
    else known.set(dir, answer);
    // Answers that arrive together (the first checks after a start) tell the page once
    if (before !== answer) notify ??= setTimeout(tell, NOTIFY_MS);
  }

  function tell() {
    notify = null;
    deps.changed();
  }

  function check(dir: string): Promise<void> {
    const running = pending.get(dir);
    if (running !== undefined) return running;
    const started = (async () => {
      await slot();
      try {
        const answer = await isDirectory(dir).then(
          (value) => {
            failures.delete(dir);
            return value;
          },
          // A refused folder (EPERM) or another error: the original text is reported and the directory stays unknown
          (error: unknown) => {
            const text = error instanceof Error ? error.message : String(error);
            if (failures.get(dir) !== text) console.error(`[orca] Checking ${dir} failed: ${text}`);
            failures.set(dir, text);
            return null;
          },
        );
        settle(dir, answer);
      } finally {
        pending.delete(dir);
        if (slow.delete(dir)) console.error(`[orca] Checking whether ${dir} exists finished`);
        release();
      }
    })();
    pending.set(dir, started);
    return started;
  }

  return {
    // Whether dir exists, by its latest check; null while unknown. Never waits; a directory never checked gets its
    // first check now
    exists(dir: string): boolean | null {
      asked.add(dir);
      if (!known.has(dir) && !pending.has(dir)) void check(dir);
      return known.get(dir) ?? null;
    },

    // One sync's checks: every directory asked about since the previous sync, waiting up to waitMs
    async refresh(): Promise<void> {
      const dirs = [...asked];
      asked = new Set();
      const late = new Set(dirs);
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all(dirs.map((dir) => check(dir).then(() => late.delete(dir)))),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, deps.waitMs);
        }),
      ]);
      clearTimeout(timer);
      for (const dir of late) {
        if (!slow.has(dir)) {
          slow.add(dir);
          console.error(
            `[orca] Checking whether ${dir} exists has taken over ${String(deps.waitMs / 1000)} s; its sessions are left out of the Orca page until the check finishes`,
          );
        }
        settle(dir, null);
      }
    },
  };
}

export type DirChecks = ReturnType<typeof createDirChecks>;
