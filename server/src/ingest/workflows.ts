import type { ToolCall } from '../db/schema.js';
import { commandsOf, obsidianArgs } from '../stages/shell.js';
import { codexSkillsOfCall } from './codex-skill.js';

// Rough check whether a session contains lfg / ic (System Design section 5, last item)
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

// Artifact paths written by wf obsidian (Stage Markers 1.7)
const wfObsidianWritten =
  /Project [^/\n]+\/Features\/[^/\n]+\/(?:Brief|Research|System Design|Tickets)\.md/;
// Linear MCP tool names: mcp__<server>__<tool>, with linear in the server name (e.g. capso-linear, claude_ai_Linear)
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
  // A Claude Code Skill call, or Codex loading a skill with cat <skill>/SKILL.md (Contracts 25.2)
  const skill = call.name === 'Skill' ? field(call.input, 'skill') : undefined;
  for (const name of typeof skill === 'string' ? [skill] : codexSkillsOfCall(call)) {
    if (lfgSkills.has(name)) flags.lfg = true;
    if (icSkills.has(name)) flags.ic = true;
  }
  if (call.name === 'Bash') {
    const command = field(call.input, 'command');
    if (typeof command === 'string') {
      // wf obsidian and gh pr in command position; calls that only mention them (echo, grep, heredoc body) do not count
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
  // Linear claim: save_issue setting an assignee, or the /claim claim comment
  const linear = linearTool.exec(call.name);
  if (linear?.[1] === 'save_issue' && typeof field(call.input, 'assignee') === 'string')
    flags.ic = true;
  if (linear?.[1] === 'save_comment') {
    const body = field(call.input, 'body');
    if (typeof body === 'string' && body.startsWith('claimed by ')) flags.ic = true;
  }
  return flags;
}

// The user starts a skill as <command-name>/interview</command-name>
export function detectFromUserText(text: string): WorkflowFlags {
  const flags = { lfg: false, ic: false };
  for (const m of text.matchAll(commandName)) {
    const skill = detectFromSkill(m[1] ?? '');
    flags.lfg ||= skill.lfg;
    flags.ic ||= skill.ic;
  }
  return flags;
}

// A skill was loaded (Codex <skill> injection)
export const detectFromSkill = (name: string): WorkflowFlags => ({
  lfg: lfgSkills.has(name),
  ic: icSkills.has(name),
});
