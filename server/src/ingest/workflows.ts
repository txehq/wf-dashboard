import type { ToolCall } from '../db/schema.js';

// session 是否含 lfg / ic 的粗判（System Design 第 5 节最后一条）
const lfgSkills = new Set(['lfg', 'interview', 'research', 'plan', 'ticketing']);
const icSkills = new Set([
  'ic',
  'claim',
  'readiness',
  'implement',
  'acceptance',
  'open-pr',
  'fix-pr',
  'ready-for-review',
]);

// 命令位置上的 wf obsidian（Stage Markers 1.7），排除只是提到命令的调用
const wfObsidian = /(?:^|[\n;&|(])\s*wf\s+obsidian\s/;
const wfObsidianNoWrite = /--dry-run\b|--help\b|\s-h\b/;
const wfObsidianWritten =
  /Project [^/\n]+\/Features\/[^/\n]+\/(?:Brief|Research|System Design|Tickets)\.md/;
const ghPr = /(?:^|[\n;&|(])\s*gh\s+pr\s/;
const linearTool = /^mcp__[^_]*linear[^_]*__(save_issue|save_comment)$/;
const commandName = /<command-name>\/([\w-]+)<\/command-name>/g;

export interface WorkflowFlags {
  lfg: boolean;
  ic: boolean;
}

function field(input: unknown, key: string): unknown {
  if (typeof input !== 'object' || input === null) return undefined;
  return (input as Record<string, unknown>)[key];
}

export function detectFromToolCall(call: ToolCall): WorkflowFlags {
  const flags = { lfg: false, ic: false };
  if (call.name === 'Skill') {
    const skill = field(call.input, 'skill');
    if (typeof skill === 'string') {
      if (lfgSkills.has(skill)) flags.lfg = true;
      if (icSkills.has(skill)) flags.ic = true;
    }
  }
  if (call.name === 'Bash') {
    const command = field(call.input, 'command');
    if (typeof command === 'string') {
      if (
        wfObsidian.test(command) &&
        !wfObsidianNoWrite.test(command) &&
        call.result !== null &&
        !call.isError &&
        wfObsidianWritten.test(call.result)
      )
        flags.lfg = true;
      if (ghPr.test(command)) flags.ic = true;
    }
  }
  // Linear 认领：save_issue 指派负责人，或 /claim 的认领评论
  const linear = linearTool.exec(call.name);
  if (linear?.[1] === 'save_issue' && typeof field(call.input, 'assignee') === 'string')
    flags.ic = true;
  if (linear?.[1] === 'save_comment') {
    const body = field(call.input, 'body');
    if (typeof body === 'string' && body.startsWith('claimed by ')) flags.ic = true;
  }
  return flags;
}

// 用户以 <command-name>/interview</command-name> 形式启动 skill
export function detectFromUserText(text: string): WorkflowFlags {
  const flags = { lfg: false, ic: false };
  for (const m of text.matchAll(commandName)) {
    const skill = m[1] ?? '';
    if (lfgSkills.has(skill)) flags.lfg = true;
    if (icSkills.has(skill)) flags.ic = true;
  }
  return flags;
}
