import fs from 'node:fs';
import path from 'node:path';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { execa } from 'execa';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import {
  artifacts,
  requests,
  runMessages,
  runs,
  sessions,
  sessionSkills,
  subagents,
  type ToolCall,
  userMessages,
} from '../db/schema.js';
import { readPrSnapshot } from '../external/github.js';
import { readRunGrades } from '../grading/index.js';
import { StoredPrSnapshot } from '../grading/pr-snapshot.js';
import { sessionConversation } from '../ingest/conversation.js';
import { resultText } from '../ingest/ingest.js';
import { AnyRecord, UserRecord } from '../ingest/records.js';
import { readReport, type StageReport } from '../stages/report.js';
import { loadTask } from '../tasks/loader.js';
import { displayUserText } from '../api/user-text.js';

// Contracts 15.2：分析目录 input/ 的内容。sessions/<id>.jsonl 每行一次请求（主 agent 与子代理），不截断

export interface ExportedToolCall {
  id: string;
  name: string;
  input: unknown;
  result: string | null;
  isError: boolean;
  // 结果溢出到 tool-results/ 的文件时，文件的完整内容
  spilledOutput: string | null;
  subagentId: string | null;
}

export interface ExportedRow {
  seq: number;
  agent: string | null;
  // 主 agent 为自己的 seq；子代理为启动它的那条主 agent 请求的 seq
  parentSeq: number;
  stage: string | null;
  timestamp: string;
  durationMs: number | null;
  model: string;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  costUsd: number;
  attributionSkill: string | null;
  userMessagesBefore: { kind: 'user' | 'notice'; text: string }[];
  skillLoads: { name: string; args: string }[];
  thinking: string | null;
  text: string | null;
  toolCalls: ExportedToolCall[];
}

// 被截断的 tool 结果从 jsonl 读回原文
function fullResults(files: string[], ids: Set<string>): Map<string, string> {
  const out = new Map<string, string>();
  if (ids.size === 0) return out;
  for (const file of files) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"tool_result"')) continue;
      const raw: unknown = JSON.parse(line);
      if (AnyRecord.parse(raw).type !== 'user') continue;
      const { content } = UserRecord.parse(raw).message;
      if (typeof content === 'string') continue;
      for (const block of content) {
        if (block.type === 'tool_result' && ids.has(block.tool_use_id)) {
          out.set(block.tool_use_id, resultText(block.content));
        }
      }
    }
  }
  const missing = [...ids].filter((id) => !out.has(id));
  if (missing.length > 0)
    throw new Error(`jsonl 中找不到这些 tool 结果的原文：${missing.join(', ')}`);
  return out;
}

function stageLabels(report: StageReport): (seq: number) => string | null {
  const spans = (['lfg', 'ic'] as const).flatMap((workflow) =>
    report[workflow].flatMap((cycle) =>
      cycle.stages.flatMap((s) =>
        s.startSeq === null || s.endSeq === null || s.endSeq < s.startSeq
          ? []
          : [
              {
                from: s.startSeq,
                to: s.endSeq,
                label: `${workflow}#${String(cycle.index)} ${s.stage}`,
              },
            ],
      ),
    ),
  );
  return (seq) => spans.find((s) => seq >= s.from && seq <= s.to)?.label ?? null;
}

export interface SessionExport {
  rows: ExportedRow[];
  report: StageReport;
}

export function exportSessionRows(db: Db, sessionId: string): SessionExport {
  const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (session === undefined) throw new Error(`session ${sessionId} 不存在`);
  const report = readReport(db, sessionId);
  if (report === null) throw new Error(`session ${sessionId} 没有阶段划分`);
  const stageOf = stageLabels(report);
  const subs = db.select().from(subagents).where(eq(subagents.sessionId, sessionId)).all();
  const rows = db
    .select()
    .from(requests)
    .where(eq(requests.sessionId, sessionId))
    .orderBy(asc(requests.timestamp), asc(requests.id))
    .all();
  const messages = db
    .select()
    .from(userMessages)
    .where(eq(userMessages.sessionId, sessionId))
    .orderBy(asc(userMessages.timestamp), asc(userMessages.id))
    .all();
  const loads = db
    .select()
    .from(sessionSkills)
    .where(eq(sessionSkills.sessionId, sessionId))
    .orderBy(asc(sessionSkills.timestamp), asc(sessionSkills.id))
    .all();

  const truncated = new Set(
    rows.flatMap((r) =>
      r.toolCalls
        .filter((c) => c.result !== null && c.resultChars > c.result.length)
        .map((c) => c.id),
    ),
  );
  const full = fullResults([session.filePath, ...subs.map((s) => s.filePath)], truncated);

  // tool_use.id → 主 agent 的 seq：主 agent 的调用即其所在行；子代理中的调用沿启动链回到主 agent
  const callSeq = new Map<string, number>();
  for (const r of rows)
    if (r.agentId === null) for (const c of r.toolCalls) callSeq.set(c.id, r.seq);
  const parentOfAgent = new Map(subs.map((s) => [s.agentId, s.parentToolUseId]));
  const agentRoot = (agentId: string, depth = 0): number => {
    const toolUseId = parentOfAgent.get(agentId);
    if (toolUseId === undefined) throw new Error(`子代理 ${agentId} 没有登记`);
    const direct = callSeq.get(toolUseId);
    if (direct !== undefined) return direct;
    const owner = rows.find((r) => r.toolCalls.some((c) => c.id === toolUseId));
    if (owner?.agentId == null || depth > 20) {
      throw new Error(`子代理 ${agentId} 的启动调用 ${toolUseId} 不在 session 中`);
    }
    return agentRoot(owner.agentId, depth + 1);
  };

  // 每个 agent 各自按时间分配上一条请求之后的用户消息与 skill 加载
  const lastAt = new Map<string | null, number>();
  const exported = rows.map((r): ExportedRow => {
    const at = r.timestamp.getTime();
    const since = lastAt.get(r.agentId) ?? Number.NEGATIVE_INFINITY;
    lastAt.set(r.agentId, at);
    const inWindow = (m: { agentId: string | null; timestamp: Date }) =>
      m.agentId === r.agentId && m.timestamp.getTime() > since && m.timestamp.getTime() <= at;
    const parentSeq = r.agentId === null ? r.seq : agentRoot(r.agentId);
    return {
      seq: r.seq,
      agent: r.agentId,
      parentSeq,
      stage: stageOf(parentSeq),
      timestamp: r.timestamp.toISOString(),
      durationMs: r.durationMs,
      model: r.model,
      tokens: {
        input: r.inputTokens,
        output: r.outputTokens,
        cacheRead: r.cacheReadTokens,
        cacheCreation: r.cacheCreationTokens,
      },
      costUsd: r.costUsd,
      attributionSkill: r.attributionSkill,
      userMessagesBefore: messages
        .filter(inWindow)
        .map((m) => ({ kind: m.kind, text: m.kind === 'user' ? displayUserText(m.text) : m.text })),
      skillLoads: loads.filter(inWindow).map((l) => ({ name: l.name, args: l.args })),
      thinking: r.thinking,
      text: r.text,
      toolCalls: r.toolCalls.map((c: ToolCall) => ({
        id: c.id,
        name: c.name,
        input: c.input,
        result: truncated.has(c.id) ? (full.get(c.id) ?? null) : c.result,
        isError: c.isError,
        spilledOutput: c.spillPath === null ? null : fs.readFileSync(c.spillPath, 'utf8'),
        subagentId: c.subagentId,
      })),
    };
  });
  return { rows: exported, report };
}

// 仓库是否存在：不存在时返回 gh 的原文；其他错误（认证、网络）以原文抛出
async function repoMissing(repo: string): Promise<string | null> {
  const result = await execa('gh', ['api', `repos/${repo}`, '--silent'], { reject: false });
  if (result.exitCode === 0) return null;
  if (result.exitCode === 1 && result.stderr.includes('HTTP 404')) return result.stderr.trim();
  throw new Error(`gh api repos/${repo} 退出码 ${String(result.exitCode)}：${result.stderr}`);
}

// run 的 session：task（不含隐藏需求、rubric 与隐藏测试）、评分与理由、产物、对话、PR 的 review 与 CI
export async function exportRun(db: Db, runId: string): Promise<unknown> {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (run === undefined) throw new Error(`run ${runId} 不存在`);
  const task = loadTask(db, run.taskId);
  const taskView =
    task.kind === 'lfg'
      ? {
          id: task.id,
          kind: task.kind,
          title: task.title,
          persona: task.persona,
          input: task.input,
        }
      : {
          id: task.id,
          kind: task.kind,
          title: task.title,
          persona: task.persona,
          ticket: task.ticket,
          requiredChecks: task.requiredChecks,
        };
  const rows = db
    .select()
    .from(artifacts)
    .where(eq(artifacts.runId, runId))
    .orderBy(asc(artifacts.id))
    .all();
  const stored = rows.find((a) => a.kind === 'pr_snapshot');
  let pr: unknown;
  if (stored !== undefined) {
    if (stored.snapshot === null) throw new Error(`run ${runId} 的 PR 快照没有内容`);
    pr = { source: 'snapshot', ...StoredPrSnapshot.parse(JSON.parse(stored.snapshot)) };
  } else if (run.githubRepo === null) {
    pr = null;
  } else {
    const missing = await repoMissing(run.githubRepo);
    pr =
      missing === null
        ? { source: 'github', pr: await readPrSnapshot(run.githubRepo) }
        : { unavailable: missing };
  }
  return {
    run: {
      id: run.id,
      status: run.status,
      error: run.error,
      humanIntervened: run.humanIntervened,
      githubRepo: run.githubRepo,
      linearIssue: run.linearIssueIdentifier,
      prUrl: run.prUrl,
      costUsd: run.costUsd,
      startedAt: run.startedAt?.toISOString() ?? null,
      endedAt: run.endedAt?.toISOString() ?? null,
    },
    task: taskView,
    grades: readRunGrades(db, runId),
    artifacts: rows
      .filter((a) => a.kind !== 'pr_snapshot')
      .map((a) => ({ kind: a.kind, location: a.location, snapshot: a.snapshot })),
    messages: db
      .select({
        role: runMessages.role,
        content: runMessages.content,
        payload: runMessages.payload,
      })
      .from(runMessages)
      .where(eq(runMessages.runId, runId))
      .orderBy(asc(runMessages.seq))
      .all(),
    pr,
  };
}

export const CaseFile = z.object({
  analysisId: z.string(),
  variant: z.object({ id: z.string(), name: z.string() }),
  sessions: z.array(
    z.object({
      id: z.string(),
      title: z.string().nullable(),
      cwd: z.string().nullable(),
      runId: z.string().nullable(),
      requests: z.number(),
      mainRequests: z.number(),
    }),
  ),
});
export type CaseFile = z.infer<typeof CaseFile>;

export interface ExportInput {
  analysisId: string;
  variant: { id: string; name: string };
  // 绑定 variant 的 src/skills
  skillsDir: string;
  sessionIds: string[];
  inputDir: string;
}

// 写出 input/；返回每个 session 的导出行，供证据校验使用
export async function writeInput(db: Db, input: ExportInput): Promise<Map<string, ExportedRow[]>> {
  const out = new Map<string, ExportedRow[]>();
  const sessionsDir = path.join(input.inputDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const meta = db
    .select({ id: sessions.id, title: sessions.title, cwd: sessions.cwd, runId: sessions.runId })
    .from(sessions)
    .where(inArray(sessions.id, input.sessionIds))
    .all();
  const caseSessions: CaseFile['sessions'] = [];
  for (const id of input.sessionIds) {
    const m = meta.find((s) => s.id === id);
    if (m === undefined) throw new Error(`session ${id} 不存在`);
    const { rows, report } = exportSessionRows(db, id);
    out.set(id, rows);
    fs.writeFileSync(
      path.join(sessionsDir, `${id}.jsonl`),
      rows.map((r) => `${JSON.stringify(r)}\n`).join(''),
    );
    const dir = path.join(sessionsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'stages.json'), `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(
      path.join(dir, 'conversation.json'),
      `${JSON.stringify(sessionConversation(db, id), null, 2)}\n`,
    );
    if (m.runId !== null) {
      fs.writeFileSync(
        path.join(dir, 'run.json'),
        `${JSON.stringify(await exportRun(db, m.runId), null, 2)}\n`,
      );
    }
    const mainRequests = db
      .select({ id: requests.id })
      .from(requests)
      .where(and(eq(requests.sessionId, id), isNull(requests.agentId)))
      .all().length;
    caseSessions.push({
      id,
      title: m.title,
      cwd: m.cwd,
      runId: m.runId,
      requests: rows.length,
      mainRequests,
    });
  }
  fs.cpSync(input.skillsDir, path.join(input.inputDir, 'skills'), { recursive: true });
  const caseFile: CaseFile = {
    analysisId: input.analysisId,
    variant: input.variant,
    sessions: caseSessions,
  };
  fs.writeFileSync(
    path.join(input.inputDir, 'case.json'),
    `${JSON.stringify(caseFile, null, 2)}\n`,
  );
  return out;
}
