import { and, eq } from 'drizzle-orm';
import { execa } from 'execa';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { artifacts, requests } from '../db/schema.js';
import { inputString, type RequestRow } from '../stages/rows.js';
import { commandsOf } from '../stages/shell.js';
import { upsertFriction } from './records.js';

// Contracts 7.10: issues and comments the agent under test files on txehq/txe-workflow via /report-friction
export const FRICTION_REPO = 'txehq/txe-workflow';
const RESULT_URL =
  /https:\/\/github\.com\/txehq\/txe-workflow\/issues\/(\d+)(?:#issuecomment-\d+)?/;

export interface FrictionCall {
  // Issue or comment URL printed by gh
  url: string;
  issueNumber: number;
  action: 'create' | 'comment';
  toolCallId: string;
}

// Whether the command contains a `gh issue create|comment ... --repo txehq/txe-workflow`. The structure is parsed by tree-sitter-bash
// (stages/shell.ts): each line of a multi-line command and each command in pipes and substitutions counts; heredoc bodies do not
function frictionAction(command: string): 'create' | 'comment' | null {
  for (const words of commandsOf(command)) {
    const [gh, issue, action] = words;
    if (gh !== 'gh' || issue !== 'issue' || (action !== 'create' && action !== 'comment')) continue;
    const repo = words.findIndex((w, i) => (w === '--repo' || w === '-R') && i > 2);
    const inline = words.some((w) => w === `--repo=${FRICTION_REPO}`);
    if (inline || (repo !== -1 && words[repo + 1] === FRICTION_REPO)) return action;
  }
  return null;
}

// Successful calls: the result is not an error and prints a txe-workflow issue URL
export function frictionCalls(rows: RequestRow[]): FrictionCall[] {
  const out: FrictionCall[] = [];
  for (const row of rows) {
    for (const call of row.toolCalls) {
      if (call.name !== 'Bash' || call.isError || call.result === null) continue;
      const command = inputString(call.input, 'command');
      if (command === null) continue;
      const action = frictionAction(command);
      const match = action === null ? null : RESULT_URL.exec(call.result);
      if (action === null || match?.[1] === undefined) continue;
      out.push({ url: match[0], issueNumber: Number(match[1]), action, toolCallId: call.id });
    }
  }
  return out;
}

const IssueView = z.object({ title: z.string() });

// Finds friction calls in the session (subagents included), writes new ones to artifacts, reads titles from GitHub
export async function recordFriction(db: Db, runId: string, sessionId: string): Promise<void> {
  const rows = db.select().from(requests).where(eq(requests.sessionId, sessionId)).all();
  for (const call of frictionCalls(rows)) {
    const existing = db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.runId, runId),
          eq(artifacts.kind, 'friction'),
          eq(artifacts.location, call.url),
        ),
      )
      .get();
    if (existing !== undefined) continue;
    const { stdout } = await execa('gh', [
      'issue',
      'view',
      String(call.issueNumber),
      '--repo',
      FRICTION_REPO,
      '--json',
      'title',
    ]);
    upsertFriction(db, runId, call.url, IssueView.parse(JSON.parse(stdout)).title);
  }
}
