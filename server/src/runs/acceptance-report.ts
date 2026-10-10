import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { requests } from '../db/schema.js';
import { inputString, type RequestRow } from '../stages/rows.js';
import { commandsOf } from '../stages/shell.js';
import { upsertArtifact } from './records.js';

// Contracts 7.2：被测 agent 的 /acceptance 用 `wf publish-artifact` 发布到 engapp.dev 的验收报告
const PAGE_URL = /https:\/\/engapp\.dev\/artifacts\/page\/[0-9a-z]+/g;
// acceptance skill 规定标题为 "<delivery> - acceptance"
const ACCEPTANCE_TITLE = /acceptance|验收/i;

export interface AcceptanceReport {
  url: string;
  title: string;
  toolCallId: string;
}

// 脚本中最后一个 `wf publish-artifact … --title <标题>` 的标题；wf 前可以有 env 与环境变量赋值；
// --dry-run 不算发布
async function publishedTitle(script: string): Promise<string | null> {
  let title: string | null = null;
  for (const argv of await commandsOf(script)) {
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

// 成功发布的验收报告；按时间顺序，最后一次在最后
export async function acceptanceReports(rows: RequestRow[]): Promise<AcceptanceReport[]> {
  const out: AcceptanceReport[] = [];
  for (const row of rows) {
    for (const call of row.toolCalls) {
      if (call.name !== 'Bash' || call.isError || call.result === null) continue;
      const command = inputString(call.input, 'command');
      if (!command?.includes('publish-artifact')) continue;
      const title = await publishedTitle(command);
      if (title === null || !ACCEPTANCE_TITLE.test(title)) continue;
      const url = [...call.result.matchAll(PAGE_URL)].at(-1)?.[0];
      if (url === undefined) continue;
      out.push({ url, title, toolCallId: call.id });
    }
  }
  return out;
}

// 主 session 与子代理中最后一次发布的验收报告写入 artifacts（每个 run 一条）
export async function recordAcceptanceReport(
  db: Db,
  runId: string,
  sessionId: string,
): Promise<void> {
  const rows = db
    .select()
    .from(requests)
    .where(eq(requests.sessionId, sessionId))
    .orderBy(asc(requests.timestamp), asc(requests.id))
    .all();
  const last = (await acceptanceReports(rows)).at(-1);
  if (last === undefined) return;
  upsertArtifact(
    db,
    runId,
    'acceptance',
    last.url,
    JSON.stringify({ title: last.title, toolCallId: last.toolCallId }),
  );
}
