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

// Content read back from the rollout when a Codex session is exported to the analysis input/ (Contracts 25.2), in Claude Code's format

export interface CodexThinking {
  type: 'thinking' | 'redacted_thinking';
  tokens: number;
}

// One instructions.json entry: path, type and original text of the instruction files loaded at once
export interface ExportedInstructions {
  timestamp: string;
  files: { path: string; type: string; content: string }[];
}

export interface CodexDetails {
  // Original text of truncated tool results: model calls by call_id, items executed in exec by item id
  results: Map<string, string>;
  // Reasoning blocks per request (response_id): thinking when they have summary text, redacted_thinking when only encrypted;
  // tokens are the request's reasoning_output_tokens split evenly across blocks
  thinking: Map<string, CodexThinking[]>;
  instructions: ExportedInstructions[];
}

// Large rollouts reach hundreds of MB; read them in chunks
const CHUNK = 64 * 1024 * 1024;

// Codex puts AGENTS.md into the context as a user message: the global one (under CODEX_HOME) has no directory after the heading, a project one does
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
    throw new Error(
      `Original text of these tool results not found in ${file}: ${missing.join(', ')}`,
    );
  return out;
}
