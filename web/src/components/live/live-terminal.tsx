import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { useFullscreenLayout } from '@/components/fullscreen';

type ServerMessage =
  { type: 'output'; data: string } | { type: 'exit' } | { type: 'error'; message: string };

type Connection = 'connecting' | 'open' | 'closed' | 'exited';

// DEC private modes that switch to the alternate screen and back (DECSET, DECRST)
const alternateModes = [47, 1047, 1049];

const connectionLabel: Record<Connection, string> = {
  connecting: 'Connecting to terminal…',
  open: 'Connected',
  closed: 'Disconnected. Refresh the page to reconnect',
  exited: 'Process exited',
};

// Terminal of an interaction session (Contracts 14.3): on connect it first receives the output the
// server kept, then live output; keyboard input and size changes go to the server. Closing the page
// only closes the connection; the process keeps running.
// The terminal fills its parent (whose height is fixed); in full screen the same terminal fills the
// window (Contracts 20.3)
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
    const serializer = new SerializeAddon();
    term.loadAddon(serializer);
    // Full-screen redrawing programs (Claude Code's tui: fullscreen, Codex) draw everything on the
    // alternate screen and leave it on exit, returning to the main screen, which holds only the first
    // line and a few lines printed afterwards. When leaving the alternate screen, record the contents of
    // both screens; after the process exits, if the main screen has gained less than a screen since,
    // append that screen after the main screen's contents: the output seen at the end stays in the
    // terminal (Contracts 14.3), on the main screen, wrapping on resize and scrollable
    let lastFullScreen: { normal: string; screen: string; row: number } | null = null;
    const switchesAlternate = (params: (number | number[])[]) =>
      params.some((p) => typeof p === 'number' && alternateModes.includes(p));
    const leaving = term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
      if (term.buffer.active.type === 'alternate' && switchesAlternate(params)) {
        // On the alternate screen, serialize outputs the main screen, the sequence entering the
        // alternate screen, and the alternate screen's contents
        const normal = serializer.serialize({ excludeModes: true, excludeAltBuffer: true });
        const both = serializer.serialize({ excludeModes: true });
        const enter = `${normal}\x1b[?1049h\x1b[H`;
        if (!both.startsWith(enter))
          throw new Error('serialize output is not main screen plus alternate screen');
        lastFullScreen = {
          normal,
          screen: both.slice(enter.length),
          row: term.buffer.normal.baseY + term.buffer.normal.cursorY,
        };
      }
      return false;
    });
    const entering = term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      if (switchesAlternate(params)) lastFullScreen = null;
      return false;
    });
    const showFinalScreen = () => {
      const normal = term.buffer.normal;
      if (lastFullScreen === null || term.buffer.active.type === 'alternate') return;
      if (normal.baseY + normal.cursorY - lastFullScreen.row >= term.rows) return;
      const { normal: before, screen } = lastFullScreen;
      term.reset();
      term.write(`${before}\r\n${screen}`);
    };
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
    // The first message after connecting is the item's kept output (earlier processes included): while
    // processing it xterm.js answers the queries inside (device attributes, focus); those answers are not
    // human input and are not sent to the current process
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
      else {
        setConnection('exited');
        // After the output received so far has been processed
        term.write('', showFinalScreen);
      }
    });
    socket.addEventListener('close', () => {
      setConnection((current) => (current === 'exited' ? current : 'closed'));
    });
    const input = term.onData((data) => {
      if (!replaying) send({ type: 'input', data });
    });
    const resizing = term.onResize(sendSize);
    // The container's size changes only with the window and layout (entering/leaving full screen,
    // opening a drawer); defer to the next frame to avoid repeated triggers in one layout pass
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
      leaving.dispose();
      entering.dispose();
      socket.close();
      term.dispose();
      handle.current = null;
    };
  }, [liveId]);

  // The frame after entering or leaving full screen: recompute rows and columns (sent to the PTY when
  // changed) and focus the terminal
  useFullscreenLayout(() => {
    if (handle.current === null) return;
    handle.current.fit.fit();
    handle.current.term.focus();
  });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1">
      {/* Height comes from the fixed outer size (fills the parent): xterm.js computes rows from the
          container size, and a container that grows with content keeps adding rows.
          Padding sits on the outer layer: FitAddon treats the container's whole height (padding
          included) as usable, so padding on the container itself adds a row and clips the last line */}
      <div className="flex min-h-0 flex-1 flex-col rounded-md bg-[#0b0d10] p-2">
        <div
          ref={container}
          className="min-h-0 flex-1 overflow-hidden"
          data-testid="live-terminal"
          data-connection={connection}
        />
      </div>
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
