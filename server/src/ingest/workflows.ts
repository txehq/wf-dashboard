import type { ToolCall } from '../db/schema.js';
import { commandsOf, obsidianArgs } from '../stages/shell.js';
import { codexSkillOfCall } from './codex-skill.js';

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

// wf obsidian 写出的产物路径（Stage Markers 1.7）
const wfObsidianWritten =
  /Project [^/\n]+\/Features\/[^/\n]+\/(?:Brief|Research|System Design|Tickets)\.md/;
// Linear MCP 的工具名：mcp__<server>__<tool>，server 名中含 linear（例如 capso-linear、claude_ai_Linear）
const linearTool = /^mcp__.*linear.*__(save_issue|save_comment)$/i;
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
  // Claude Code 的 Skill 调用，或 Codex 以 cat <skill>/SKILL.md 加载 skill（Contracts 25.2）
  const skill = call.name === 'Skill' ? field(call.input, 'skill') : codexSkillOfCall(call);
  if (typeof skill === 'string') {
    if (lfgSkills.has(skill)) flags.lfg = true;
    if (icSkills.has(skill)) flags.ic = true;
  }
  if (call.name === 'Bash') {
    const command = field(call.input, 'command');
    if (typeof command === 'string') {
      // 命令位置上的 wf obsidian 与 gh pr；只是提到命令（echo、grep、heredoc 正文）的调用不算
      const commands = commandsOf(command);
      const writes = commands.some((argv) => {
        const args = obsidianArgs(argv);
        return args !== null && !args.dryRun && !args.help;
      });
      if (writes && call.result !== null && !call.isError && wfObsidianWritten.test(call.result))
        flags.lfg = true;
      if (commands.some((argv) => argv[0] === 'gh' && argv[1] === 'pr')) flags.ic = true;
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
