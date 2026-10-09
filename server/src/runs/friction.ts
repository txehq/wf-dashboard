import { and, eq } from 'drizzle-orm';
import { execa } from 'execa';
import { parse } from 'shell-quote';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { artifacts, requests } from '../db/schema.js';
import { inputString, type RequestRow } from '../stages/rows.js';
import { upsertFriction } from './records.js';

// Contracts 7.10：被测 agent 的 /report-friction 在 txehq/txe-workflow 提的 issue 与评论
export const FRICTION_REPO = 'txehq/txe-workflow';
const RESULT_URL = /https:\/\/github\.com\/txehq\/txe-workflow\/issues\/(\d+)(?:#issuecomment-\d+)?/;

export interface FrictionCall {
  // gh 打印的 issue 或评论 URL
  url: string;
  issueNumber: number;
  action: 'create' | 'comment';
  toolCallId: string;
}

// 命令中是否有一段 `gh issue create|comment … --repo txehq/txe-workflow`；复合命令按 shell 运算符切段
function frictionAction(command: string): 'create' | 'comment' | null {
  const segments: string[][] = [[]];
  for (const token of parse(command)) {
    if (typeof token === 'string') segments[segments.length - 1]?.push(token);
    else if ('op' in token) segments.push([]);
  }
  for (const words of segments) {
    const [gh, issue, action] = words;
    if (gh !== 'gh' || issue !== 'issue' || (action !== 'create' && action !== 'comment')) continue;
    const repo = words.findIndex((w, i) => (w === '--repo' || w === '-R') && i > 2);
    const inline = words.some((w) => w === `--repo=${FRICTION_REPO}`);
    if (inline || (repo !== -1 && words[repo + 1] === FRICTION_REPO)) return action;
  }
  return null;
}

// 成功的调用：结果不是错误，并且打印了 txe-workflow 的 issue URL
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

// 识别 session（含子代理）中的 friction 调用，新出现的写入 artifacts，标题从 GitHub 读取
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
