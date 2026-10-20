#!/usr/bin/env node
// Codex 会话的替身命令（测试用，只验证页面与 API，不验证 Codex 本身）：按 codex-cli 0.162.0 的形状在
// $CODEX_HOME/sessions/ 写出 rollout（第一行 session_meta，其中记下收到的参数），回显终端输入，连按两次 Ctrl-C 退出。
// 与 codex-cli 相同：没有 CODEX_HOME 时用 $HOME/.codex；带初始消息时立即写出 rollout，不带时在提交第一条消息时写出
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const argv = process.argv.slice(2);
const { positionals } = parseArgs({
  args: argv,
  allowPositionals: true,
  options: {
    'no-daemon': { type: 'boolean' },
    'dangerously-bypass-approvals-and-sandbox': { type: 'boolean' },
    s: { type: 'string' },
    c: { type: 'string', multiple: true },
  },
});
const home = process.env.CODEX_HOME ?? path.join(process.env.HOME ?? '', '.codex');
if (process.env.CODEX_HOME === undefined && process.env.HOME === undefined) {
  throw new Error('没有 CODEX_HOME 与 HOME');
}
const sessions = path.join(home, 'sessions');

function rolloutOf(id) {
  for (const entry of fs.readdirSync(sessions, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(`-${id}.jsonl`)) {
      return path.join(entry.parentPath, entry.name);
    }
  }
  throw new Error(`没有会话 ${id}`);
}

const record = (file, type, payload) => {
  fs.appendFileSync(
    file,
    `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`,
  );
};

const resuming = positionals[0] === 'resume';
const prompt = resuming ? positionals[2] : positionals[0];
const id = resuming ? positionals[1] : randomUUID();
let file = resuming ? rolloutOf(id) : null;

function create() {
  const now = new Date();
  const day = now.toISOString().slice(0, 10).split('-');
  const dir = path.join(sessions, ...day);
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(
    dir,
    `rollout-${now.toISOString().replaceAll(':', '-').slice(0, 19)}-${id}.jsonl`,
  );
  record(file, 'session_meta', {
    id,
    session_id: id,
    timestamp: now.toISOString(),
    cwd: process.cwd(),
    originator: 'codex-stand-in',
    argv,
  });
}

if (resuming) record(file, 'event_msg', { type: 'resumed', argv });
else if (prompt !== undefined) create();
if (prompt !== undefined) record(file, 'event_msg', { type: 'user_message', message: prompt });

// STAND_IN_STATUS_LINE=1 时与 codex-cli 一样整屏重画：输出在上面，最后一行是状态行 `底部状态行 <列>x<行>`，
// 终端尺寸变化时重画
const statusLine = process.env.STAND_IN_STATUS_LINE === '1';
let transcript = '';
const redraw = () => {
  const rows = process.stdout.rows;
  const shown = transcript
    .split('\r\n')
    .slice(-(rows - 1))
    .join('\r\n');
  const status = `底部状态行 ${String(process.stdout.columns)}x${String(rows)}`;
  process.stdout.write(`\x1b[H\x1b[2J${shown}\x1b[${String(rows)};1H${status}`);
};
const write = (text) => {
  if (!statusLine) {
    process.stdout.write(text);
    return;
  }
  transcript += text;
  redraw();
};
if (statusLine) process.stdout.on('resize', redraw);

write(`>_ Codex 替身（测试） · 会话 ${id}\r\n`);
write(`argv: ${argv.filter((a) => a !== prompt).join(' ')}\r\n`);
write(`cwd: ${process.cwd()}\r\n`);
if (prompt !== undefined) write(`› ${String(prompt).split('\n')[0]}\r\n`);
write('› ');

let interrupts = 0;
// 这一条消息到目前为止输入的文字：回车提交时与 codex-cli 0.162.1 相同地记一条 item_completed（UserMessage）
let typed = '';
process.stdin.setRawMode(true);
process.stdin.on('data', (chunk) => {
  const text = chunk.toString('utf8');
  if (text === '\u0003') {
    interrupts += 1;
    if (interrupts >= 2) process.exit(0);
    return;
  }
  interrupts = 0;
  // 没有初始消息时，提交第一条消息才写出 rollout
  if (file === null && text.includes('\r')) create();
  if (file !== null) record(file, 'event_msg', { type: 'input', text });
  typed += text.split('\r')[0];
  if (text.includes('\r')) {
    if (file !== null && typed.trim() !== '') {
      record(file, 'event_msg', {
        type: 'item_completed',
        item: {
          type: 'UserMessage',
          id: randomUUID(),
          content: [{ type: 'text', text: typed, text_elements: [] }],
        },
      });
    }
    typed = '';
  }
  write(text === '\r' ? '\r\n› ' : text);
});
