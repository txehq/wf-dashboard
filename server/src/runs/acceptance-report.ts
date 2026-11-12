import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { requests } from '../db/schema.js';
import { inputString, type RequestRow } from '../stages/rows.js';
import { commandsOf } from '../stages/shell.js';
import { COST_REFRESH_MS, onSessionUpdates } from './cost-refresh.js';
import { upsertArtifact } from './records.js';

// Contracts 7.2: the acceptance report the agent under test publishes to engapp.dev with `wf publish-artifact` in /acceptance
const PAGE_URL = /https:\/\/engapp\.dev\/artifacts\/page\/[0-9a-z]+/g;
// The acceptance skill sets the title to "<delivery> - acceptance"
// Acceptance report titles; the code points are the Chinese word for acceptance, used by runs recorded before
// Contracts 36
const ACCEPTANCE_TITLE = /acceptance|\u{9A8C}\u{6536}/iu;

export interface AcceptanceReport {
  url: string;
  title: string;
  toolCallId: string;
}

// Title of the last `wf publish-artifact … --title <title>` in the script; env and variable assignments may precede wf;
// --dry-run does not count as publishing
function publishedTitle(script: string): string | null {
  let title: string | null = null;
  for (const argv of commandsOf(script)) {
    const at = argv.findIndex(
      (w, i) => path.basename(w) === 'wf' && argv[i + 1] === 'publish-artifact',
    );
    if (at === -1) continue;
    const args = argv.slice(at + 2);
    if (args.includes('--dry-run')) continue;
    const flag = args.indexOf('--title');
    const inline = args.find((a) => a.startsWith('--title='));
    title = flag !== -1 ? (args[flag + 1] ?? null) : (inline?.slice('--title='.length) ?? null);
  }
  return title;
}

// Acceptance reports published successfully, in time order with the latest last
export function acceptanceReports(rows: RequestRow[]): AcceptanceReport[] {
  const out: AcceptanceReport[] = [];
  for (const row of rows) {
    for (const call of row.toolCalls) {
      if (call.name !== 'Bash' || call.isError || call.result === null) continue;
      const command = inputString(call.input, 'command');
      if (!command?.includes('publish-artifact')) continue;
      const title = publishedTitle(command);
      if (title === null || !ACCEPTANCE_TITLE.test(title)) continue;
      const url = [...call.result.matchAll(PAGE_URL)].at(-1)?.[0];
      if (url === undefined) continue;
      out.push({ url, title, toolCallId: call.id });
    }
  }
  return out;
}

// The last acceptance report published in the main session and subagents goes into artifacts (one per run)
export function recordAcceptanceReport(db: Db, runId: string, sessionId: string): void {
  const rows = db
    .select()
    .from(requests)
    .where(eq(requests.sessionId, sessionId))
    .orderBy(asc(requests.timestamp), asc(requests.id))
    .all();
  const last = acceptanceReports(rows).at(-1);
  if (last === undefined) return;
  upsertArtifact(
    db,
    runId,
    'acceptance',
    last.url,
    JSON.stringify({ title: last.title, toolCallId: last.toolCallId }),
  );
}

// /ic is one whole round: besides the end of each round and of the run, scan whenever the session gets new requests
// (throttled like the cost refresh), so a published acceptance report shows in run details within a minute. Returns a
// stop function
export function watchAcceptanceReport(
  db: Db,
  runId: string,
  sessionId: string,
  onError: (error: Error) => void,
  intervalMs = COST_REFRESH_MS,
): () => void {
  return onSessionUpdates(
    sessionId,
    () => {
      recordAcceptanceReport(db, runId, sessionId);
    },
    onError,
    intervalMs,
  );
}
