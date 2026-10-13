import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { useFullscreenLayout } from '@/components/fullscreen';

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
// 键盘输入与尺寸变化发给服务端。关掉页面只关闭连接，进程继续运行。
// 终端占满父元素（父元素的高度是定值）；全屏时同一个终端随之铺满窗口（Contracts 20.3）
export function LiveTerminal({ liveId }: { liveId: string }) {
  const container = useRef<HTMLDivElement>(null);
  const handle = useRef<{ term: Terminal; fit: FitAddon } | null>(null);
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
    handle.current = { term, fit };
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
    // 容器的尺寸只随窗口与布局变化（进入与退出全屏、打开抽屉）；放到下一帧，避免在同一次布局中反复触发
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
      handle.current = null;
    };
  }, [liveId]);

  // 进入与退出全屏后的下一帧：重新计算行列（变化时发给 PTY），终端获得焦点
  useFullscreenLayout(() => {
    if (handle.current === null) return;
    handle.current.fit.fit();
    handle.current.term.focus();
  });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1">
      {/* 高度由外层的定值决定（占满父元素）：xterm.js 按容器大小算行数，容器随内容长高会让行数不断增加 */}
      <div
        ref={container}
        className="min-h-0 flex-1 overflow-hidden rounded-md bg-[#0b0d10] p-2"
        data-testid="live-terminal"
        data-connection={connection}
      />
      <p className="text-xs text-muted-foreground" data-testid="terminal-connection">
        {connectionLabel[connection]}
        {error !== null && (
          <span role="alert" className="ml-2 text-destructive">
            {error}
          </span>
        )}
      </p>
    </div>
  );
}
