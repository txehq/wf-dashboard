import path from 'node:path';
import { commandsOf } from '../stages/shell.js';

// Codex 加载 skill 的方式（Contracts 25.2，Reports/W62 实测）：模型以 exec_command 执行一次 cat <目录>/<skill>/SKILL.md，
// 输出就是 SKILL.md 的全文。只看整条命令就是一次 cat 的读取：nl、sed、awk 读取一段与带管道的命令是在读或改 skill，不是加载

// 一条命令读取的 skill：{ name, path }；不是加载 skill 时为 null。path 是命令中写的路径（可以是相对 cwd 的）
export function catSkill(cmd: string): { name: string; path: string } | null {
  const commands = commandsOf(cmd);
  const [argv] = commands;
  if (commands.length !== 1 || argv?.length !== 2 || argv[0] !== 'cat') return null;
  const file = argv[1] ?? '';
  if (path.basename(file) !== 'SKILL.md') return null;
  const name = path.basename(path.dirname(file));
  return name === '' || name === '.' ? null : { name, path: file };
}

// 请求中的一个 tool 调用是否加载了 skill：exec_command（模型直接调用，或 exec 脚本中执行的命令）的 cmd 为一次 cat，且没有失败
export function codexSkillOfCall(call: {
  name: string;
  input: unknown;
  isError?: boolean;
}): string | null {
  if (call.name !== 'exec_command' || call.isError === true) return null;
  if (typeof call.input !== 'object' || call.input === null) return null;
  const cmd = (call.input as Record<string, unknown>).cmd;
  return typeof cmd === 'string' ? (catSkill(cmd)?.name ?? null) : null;
}

// 命令中的路径按命令的工作目录解析为绝对路径
export function resolveSkillPath(skillPath: string, cwd: string): string {
  return path.isAbsolute(skillPath) ? skillPath : path.join(cwd, skillPath);
}
