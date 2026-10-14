#!/usr/bin/env node
// Live 中 Claude Code 的替身命令（基础档 e2e 用 WFD_CLAUDE_BIN 换上，只验证页面与终端，不验证 Claude Code 本身）：
// 启动与每次 SIGWINCH 时写出终端的列数与行数，把收到的每段输入以 JSON 字符串回显（Esc 显示为 "\u001b"）。
// 收到 SIGINT 时与真实的 Claude Code 一样退出（实测，Reports/W56）；STAND_IN_IGNORE_SIGINT=1 时不理会 SIGINT，
// 用来测试"结束进程"在 SIGINT 之后补发 SIGTERM
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');

const size = () => {
  process.stdout.write(`size ${String(process.stdout.columns)}x${String(process.stdout.rows)}\r\n`);
};

process.stdout.write('Claude Code 替身（测试）\r\n');
size();
process.on('SIGWINCH', size);
process.stdin.on('data', (data) => {
  process.stdout.write(`key ${JSON.stringify(data)}\r\n`);
});
if (process.env.STAND_IN_IGNORE_SIGINT === '1') {
  process.on('SIGINT', () => {
    process.stdout.write('sigint ignored\r\n');
  });
}
