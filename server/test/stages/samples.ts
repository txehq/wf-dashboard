import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Db } from '../../src/db/index.js';
import { ingestFile } from '../../src/ingest/ingest.js';
import { models } from '../../src/llm/client.js';
import { loadSessionRows, type RequestRow, type SessionRows } from '../../src/stages/rows.js';

// 真实判定测试使用的模型：阶段判定的当前默认值（haiku 别名，可用 WFD_STAGE_CHECK_MODEL 覆盖），与产品中一致
export const TEST_STAGE_MODEL = models.stageCheck;

// 真实样本在主仓库的 .spikes/stage-markers/samples/（Stage Markers 第 4 节），worktree 经 git common dir 找到主仓库
const mainRepo = path.dirname(
  path.resolve(execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim()),
);
export const samplesDir = path.join(mainRepo, '.spikes', 'stage-markers', 'samples');

export const SAMPLES = {
  icPrs: path.join(
    samplesDir,
    '-Users-linhaoz-Project-txe-txe-workflow/f0aca373-863f-4d62-babd-f48055092328.jsonl',
  ),
  research: path.join(
    samplesDir,
    '-Users-linhaoz-Project-txe-txe-workflow/9f4adf2d-0730-4214-994a-4fba7f7b9161.jsonl',
  ),
  interview: path.join(
    samplesDir,
    '-Users-linhaoz-orca-projects-wf-dashboard/d93c4511-3c62-4b3b-8ee6-bf73370cd150.jsonl',
  ),
};

const Line = z.looseObject({
  type: z.string(),
  message: z.looseObject({ id: z.string().optional(), content: z.unknown().optional() }).optional(),
});
const ToolUse = z.looseObject({ type: z.literal('tool_use'), id: z.string() });

// jsonl 行号（从 1 开始），用来与 Stage Markers 中按行号写出的结果对照
export interface LineIndex {
  // tool_use.id → 所在行
  toolLine: Map<string, number>;
  // message.id → 首条记录所在行
  messageLine: Map<string, number>;
}

export function lineIndex(file: string): LineIndex {
  const toolLine = new Map<string, number>();
  const messageLine = new Map<string, number>();
  for (const [i, raw] of fs.readFileSync(file, 'utf8').split('\n').entries()) {
    if (raw.trim() === '') continue;
    const rec = Line.parse(JSON.parse(raw));
    if (rec.type !== 'assistant' || rec.message?.id === undefined) continue;
    if (!messageLine.has(rec.message.id)) messageLine.set(rec.message.id, i + 1);
    const content = rec.message.content;
    for (const block of Array.isArray(content) ? content : []) {
      const t = ToolUse.safeParse(block);
      if (t.success) toolLine.set(t.data.id, i + 1);
    }
  }
  return { toolLine, messageLine };
}

export type Sample = SessionRows & LineIndex;

// 用 ingest 导入样本（含子代理），再按 stages 模块的方式读回
export function ingestSample(db: Db, file: string): Sample {
  const { sessionId } = ingestFile(db, file);
  return { ...loadSessionRows(db, sessionId), ...lineIndex(file) };
}

// 主 session 中首条记录位于 [from, to] 行的请求
export function mainRowsInLines(s: Sample, from: number, to: number): RequestRow[] {
  return s.main.filter((r) => {
    const line = s.messageLine.get(r.messageId);
    return line !== undefined && line >= from && line <= to;
  });
}

// tool 调用所在的 jsonl 行 → 所在请求的 seq
export function seqOfToolLine(s: Sample, line: number): number {
  const row = s.main.find((r) => r.toolCalls.some((c) => s.toolLine.get(c.id) === line));
  if (!row) throw new Error(`第 ${String(line)} 行没有主 session 的 tool 调用`);
  return row.seq;
}
