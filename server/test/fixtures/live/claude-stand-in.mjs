#!/usr/bin/env node
// Live 中 Claude Code 的替身命令（基础档 e2e 用 WFD_CLAUDE_BIN 换上，只验证页面与终端，不验证 Claude Code 本身）：
// 启动与每次 SIGWINCH 时写出终端的列数与行数，把收到的每段输入以 JSON 字符串回显（Esc 显示为 "\u001b"）。
// 收到 SIGINT 时与真实的 Claude Code 一样退出（实测，Reports/W56）；STAND_IN_IGNORE_SIGINT=1 时不理会 SIGINT，
// 用来测试"结束进程"在 SIGINT 之后补发 SIGTERM。
// STAND_IN_STATUS_LINE=1 时与 Claude Code 一样整屏重画：输出在上面，最后一行是状态行 `底部状态行 <列>x<行>`；
// 同时与 Claude Code 的 tui: fullscreen 一样在备用屏幕中画，收到 SIGINT 时离开备用屏幕，在主屏幕上打印 resume 提示后退出
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');

const statusLine = process.env.STAND_IN_STATUS_LINE === '1';
if (statusLine) process.stdout.write('\x1b[?1049h');
const lines = [];
const redraw = () => {
  const rows = process.stdout.rows;
  const shown = lines.slice(-(rows - 1)).join('\r\n');
  const status = `底部状态行 ${String(process.stdout.columns)}x${String(rows)}`;
  process.stdout.write(`\x1b[H\x1b[2J${shown}\x1b[${String(rows)};1H${status}`);
};
const print = (line) => {
  if (!statusLine) {
    process.stdout.write(`${line}\r\n`);
    return;
  }
  lines.push(line);
  redraw();
};

const size = () => {
  print(`size ${String(process.stdout.columns)}x${String(process.stdout.rows)}`);
};

print('Claude Code 替身（测试）');
// 收到的参数与 Magi Agent 的两个环境变量（Magi Agent 的测试据此确认注入的说明与 resume 的会话）
if (process.env.STAND_IN_ECHO_ARGV === '1') {
  print(`argv ${JSON.stringify(process.argv.slice(2))}`);
  print(
    `magi ${JSON.stringify([process.env.MAGI_LIVE_ID ?? null, process.env.MAGI_DASHBOARD_URL ?? null])}`,
  );
  // 所用的配置：本机配置不设 CLAUDE_CONFIG_DIR，variant 的配置来自它的 runtimeEnv
  print(
    `config ${JSON.stringify([process.env.CLAUDE_CONFIG_DIR ?? null, process.env.WF_HOME ?? null, process.env.HOME ?? null])}`,
  );
}
size();
process.on('SIGWINCH', size);
process.stdin.on('data', (data) => {
  print(`key ${JSON.stringify(data)}`);
});
if (process.env.STAND_IN_IGNORE_SIGINT === '1') {
  process.on('SIGINT', () => {
    print('sigint ignored');
  });
} else if (statusLine) {
  process.on('SIGINT', () => {
    process.stdout.write(
      '\x1b[?1049l\r\nResume this session with:\r\nclaude --resume stand-in\r\n',
    );
    process.exit(0);
  });
}
