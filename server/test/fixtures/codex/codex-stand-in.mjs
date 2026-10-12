#!/usr/bin/env node
// Codex 会话的替身命令（测试用，只验证页面与 API，不验证 Codex 本身）：按 codex-cli 0.162.0 的形状在
// $CODEX_HOME/sessions/ 写出 rollout（第一行 session_meta），回显终端输入，连按两次 Ctrl-C 退出
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const home = process.env.CODEX_HOME;
if (home === undefined) throw new Error('没有 CODEX_HOME');
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

let file;
let id;
if (args[0] === 'resume') {
  id = args.at(-1);
  file = rolloutOf(id);
  record(file, 'event_msg', { type: 'resumed' });
} else {
  id = randomUUID();
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
    cwd: process.cwd(),
    originator: 'codex-stand-in',
  });
  record(file, 'event_msg', { type: 'user_message', message: args.at(-1) });
}

process.stdout.write(`>_ Codex 替身（测试） · 会话 ${id}\r\n`);
process.stdout.write(`argv: ${args.slice(0, -1).join(' ')}\r\n`);
process.stdout.write(`cwd: ${process.cwd()}\r\n`);
if (args[0] !== 'resume') process.stdout.write(`› ${String(args.at(-1)).split('\n')[0]}\r\n`);
process.stdout.write('› ');

let interrupts = 0;
process.stdin.setRawMode(true);
process.stdin.on('data', (chunk) => {
  const text = chunk.toString('utf8');
  if (text === '\u0003') {
    interrupts += 1;
    if (interrupts >= 2) process.exit(0);
    return;
  }
  interrupts = 0;
  record(file, 'event_msg', { type: 'input', text });
  process.stdout.write(text === '\r' ? '\r\n› ' : text);
});
