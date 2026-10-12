import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';

type ServerMessage =
  { type: 'output'; data: string } | { type: 'exit' } | { type: 'error'; message: string };

type Connection = 'connecting' | 'open' | 'closed' | 'exited';

const connectionLabel: Record<Connection, string> = {
  connecting: '正在连接终端…',
  open: '已连接',
  closed: '连接已断开，刷新页面重新连接',
  exited: '进程已退出',
};

// 一个交互 session 的终端（Contracts 14.3）：连接时先收到服务端保留的输出，之后实时转发；
// 键盘输入与尺寸变化发给服务端。关掉页面只关闭连接，进程继续运行
export function LiveTerminal({ liveId }: { liveId: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = container.current;
    if (element === null) return;
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 10_000,
      theme: { background: '#0b0d10' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    fit.fit();
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${window.location.host}/api/live/${liveId}/pty`);
    const send = (message: unknown) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    const sendSize = () => {
      send({ type: 'resize', cols: term.cols, rows: term.rows });
    };
    socket.addEventListener('open', () => {
      setConnection('open');
      sendSize();
    });
    // 连接后的第一条消息是这一项保留的输出（含之前进程的）：xterm.js 处理它时会回答其中的查询（设备属性、焦点），
    // 这些回答不是人的输入，不发给现在的进程
    let replaying = true;
    socket.addEventListener('message', (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data) as ServerMessage;
      if (message.type === 'output') {
        if (replaying) {
          term.write(message.data, () => {
            replaying = false;
            term.focus();
          });
        } else term.write(message.data);
      } else if (message.type === 'error') setError(message.message);
      else setConnection('exited');
    });
    socket.addEventListener('close', () => {
      setConnection((current) => (current === 'exited' ? current : 'closed'));
    });
    const input = term.onData((data) => {
      if (!replaying) send({ type: 'input', data });
    });
    const resizing = term.onResize(sendSize);
    // 容器高度固定，行列只随窗口与布局变化；放到下一帧，避免在同一次布局中反复触发
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        fit.fit();
      });
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      input.dispose();
      resizing.dispose();
      socket.close();
      term.dispose();
    };
  }, [liveId]);

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      {/* 高度固定：xterm.js 按容器大小算行数，容器随内容长高会让行数不断增加 */}
      <div
        ref={container}
        className="h-[calc(100vh-18rem)] min-h-[28rem] overflow-hidden rounded-md bg-[#0b0d10] p-2"
        data-testid="live-terminal"
        data-connection={connection}
      />
      <p className="text-xs text-muted-foreground" data-testid="terminal-connection">
        {connectionLabel[connection]}
      </p>
      {error !== null && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
