// Claude Code records a user message that starts with a slash command as
// <command-message>lfg</command-message> <command-name>/lfg</command-name> <command-args>Build a calculator…</command-args>;
// the page shows "/lfg Build a calculator…" (command name plus the raw args)
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

// Raw args of a slash command message (whitespace kept); null when not a slash command, empty string without args
export function commandArgs(text: string): string | null {
  if (!COMMAND_MARKUP.test(text) || COMMAND_NAME.exec(text) === null) return null;
  return COMMAND_ARGS.exec(text)?.[1] ?? '';
}

const TITLE_LENGTH = 80;

// List title: first 80 characters of the first user message, whitespace collapsed; for a slash command, the first line of name plus args
export function sessionTitle(firstUserText: string): string {
  const shown = displayUserText(firstUserText);
  const text = shown === firstUserText ? shown : (shown.split('\n')[0] ?? '');
  return Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, TITLE_LENGTH).join('');
}
