// 用户以 slash 命令开始的消息，Claude Code 记录为
// <command-message>lfg</command-message> <command-name>/lfg</command-name> <command-args>做一个计算器…</command-args>；
// 页面显示为 "/lfg 做一个计算器…"（命令名加参数原文）
const COMMAND_NAME = /<command-name>([^<]*)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const COMMAND_MARKUP = /^\s*<command-(?:message|name|args)>/;

export function displayUserText(text: string): string {
  if (!COMMAND_MARKUP.test(text)) return text;
  const name = COMMAND_NAME.exec(text)?.[1]?.trim();
  if (name === undefined || name === '') return text;
  const args = COMMAND_ARGS.exec(text)?.[1]?.trim() ?? '';
  return args === '' ? name : `${name} ${args}`;
}

const TITLE_LENGTH = 80;

// 列表标题：首条用户消息的前 80 个字符，空白压成一个空格；slash 命令为命令名加参数的第一行
export function sessionTitle(firstUserText: string): string {
  const shown = displayUserText(firstUserText);
  const text = shown === firstUserText ? shown : (shown.split('\n')[0] ?? '');
  return Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, TITLE_LENGTH).join('');
}
