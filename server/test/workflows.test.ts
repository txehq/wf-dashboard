import { describe, expect, test } from 'vitest';
import type { ToolCall } from '../src/db/schema.js';
import { detectFromToolCall } from '../src/ingest/workflows.js';

function call(name: string, input: unknown, result: string | null = 'ok'): ToolCall {
  return {
    id: 'toolu_x',
    name,
    input,
    result,
    resultChars: result?.length ?? 0,
    isError: false,
    spillPath: null,
    subagentId: null,
  };
}

const written = '/vault/Project Magi Eval/Features/r-1/Brief.md';

// session 粗判：命令的结构由 tree-sitter-bash 解析（W18b 第 4 项），以前是按行首匹配的正则
describe('workflow 粗判', () => {
  test('wf --json obsidian 写出产物算 lfg；--dry-run、heredoc 正文中的命令不算', () => {
    const bash = (command: string) => detectFromToolCall(call('Bash', { command }, written));
    expect(bash('wf --json obsidian --kind brief --file .interview/brief.md').lfg).toBe(true);
    expect(bash('cd /x && wf obsidian --kind brief --file b.md').lfg).toBe(true);
    expect(bash('wf obsidian --kind brief --file b.md --dry-run').lfg).toBe(false);
    expect(bash("cat > n.md <<'EOF'\nwf obsidian --kind brief --file b.md\nEOF").lfg).toBe(false);
  });

  test('gh pr 只在命令位置上算 ic', () => {
    const bash = (command: string) => detectFromToolCall(call('Bash', { command }));
    expect(bash('sleep 5; gh pr checks 1 --repo o/r').ic).toBe(true);
    expect(bash('echo "$(gh pr view 2 --json url)"').ic).toBe(true);
    expect(bash("cat > n.md <<'EOF'\ngh pr view 1\nEOF").ic).toBe(false);
    expect(bash('grep "gh pr ready" notes.md').ic).toBe(false);
  });

  // W15 Low 15：以前的 [^_]*linear 匹配不到 claude.ai 的 Linear 连接器
  test('claude.ai 的 Linear 连接器的认领也算 ic', () => {
    const claim = { id: 'TXE-1', assignee: 'me' };
    expect(detectFromToolCall(call('mcp__claude_ai_Linear__save_issue', claim)).ic).toBe(true);
    expect(detectFromToolCall(call('mcp__capso-linear__save_issue', claim)).ic).toBe(true);
    expect(detectFromToolCall(call('mcp__capso-linear__save_issue', { id: 'TXE-1' })).ic).toBe(
      false,
    );
  });
});
