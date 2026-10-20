import path from 'node:path';
import {
  CodexLine,
  CompletedItem,
  ItemCompleted,
  knownItemTypes,
  ResponseItem,
  TokenUsageRecord,
} from '../ingest/codex-records.js';
import { codexHomeOf, executedResult, outputText } from '../ingest/codex.js';
import { readCompleteLines } from '../ingest/ingest.js';

// Codex 的 session 导出到分析的 input/ 时（Contracts 25.2）从 rollout 读回的内容，格式与 Claude Code 的相同

export interface CodexThinking {
  type: 'thinking' | 'redacted_thinking';
  tokens: number;
}

// instructions.json 的一项：一次加载的指令文件的路径、类型与原文
export interface ExportedInstructions {
  timestamp: string;
  files: { path: string; type: string; content: string }[];
}

export interface CodexDetails {
  // 被截断的 tool 结果的原文：模型的调用按 call_id，exec 中执行的项按 item id
  results: Map<string, string>;
  // 每次请求（response_id）的推理块：有摘要文字的为 thinking，只有加密内容的为 redacted_thinking；
  // token 数为这次请求的 reasoning_output_tokens，由各块均分
  thinking: Map<string, CodexThinking[]>;
  instructions: ExportedInstructions[];
}

// 大的 rollout 有几百 MB，按段读
const CHUNK = 64 * 1024 * 1024;

// AGENTS.md 由 Codex 作为一条 user 消息放进上下文：全局的（CODEX_HOME 下）标题后没有目录，项目的带目录
const AGENTS_HEADER =
  /^# AGENTS\.md instructions(?: for (.+))?\n\n<INSTRUCTIONS>\n([\s\S]*)\n<\/INSTRUCTIONS>$/;

function split(total: number, count: number): number[] {
  const each = Math.floor(total / count);
  const rest = total - each * count;
  return Array.from({ length: count }, (_, i) => each + (i < rest ? 1 : 0));
}

export function codexDetails(file: string, truncated: ReadonlySet<string>): CodexDetails {
  const out: CodexDetails = { results: new Map(), thinking: new Map(), instructions: [] };
  const home = codexHomeOf(file);
  let blocks: CodexThinking['type'][] = [];
  let offset = 0;
  for (;;) {
    const { lines, end, more } = readCompleteLines(file, offset, CHUNK);
    for (const line of lines) {
      const record = CodexLine.parse(JSON.parse(line));
      if (record.type === 'response_item') {
        const item = ResponseItem.parse(record.payload);
        if (item.type === 'reasoning') {
          const summary = (item.summary ?? []).some((s) => (s.text ?? '') !== '');
          blocks.push(summary ? 'thinking' : 'redacted_thinking');
        }
        if (
          (item.type === 'custom_tool_call_output' || item.type === 'function_call_output') &&
          truncated.has(item.call_id)
        )
          out.results.set(item.call_id, outputText(item.output));
        if (item.type === 'message' && item.role === 'user') {
          const files = item.content.flatMap((part) => {
            const m = AGENTS_HEADER.exec(part.text ?? '');
            if (m === null) return [];
            const dir = m[1];
            return [
              {
                path: path.join(dir ?? home, 'AGENTS.md'),
                type: dir === undefined ? 'User' : 'Project',
                content: m[2] ?? '',
              },
            ];
          });
          if (files.length > 0) out.instructions.push({ timestamp: record.timestamp, files });
        }
      }
      if (record.type === 'event_msg') {
        const completed = ItemCompleted.safeParse(record.payload);
        if (
          completed.success &&
          (knownItemTypes as readonly string[]).includes(completed.data.item.type)
        ) {
          const item = CompletedItem.parse(completed.data.item);
          const result = truncated.has(item.id) ? executedResult(item) : null;
          if (result !== null) out.results.set(item.id, result.text);
        }
      }
      if (record.type === 'token_usage_record') {
        const usage = TokenUsageRecord.parse(record.payload);
        if (blocks.length > 0) {
          const tokens = split(usage.usage.reasoning_output_tokens ?? 0, blocks.length);
          out.thinking.set(
            usage.response_id,
            blocks.map((type, i) => ({ type, tokens: tokens[i] ?? 0 })),
          );
        }
        blocks = [];
      }
    }
    offset = end;
    if (!more) break;
  }
  const missing = [...truncated].filter((id) => !out.results.has(id));
  if (missing.length > 0)
    throw new Error(`${file} 中找不到这些 tool 结果的原文：${missing.join(', ')}`);
  return out;
}
