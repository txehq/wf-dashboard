import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { app, BrowserWindow, dialog, Menu, nativeImage, screen, shell, Tray } from 'electron';

// WF Dashboard.app (Contracts 39.2a): a window and a menu bar icon over the dashboard's local server. The server runs
// with the bundled Node 22 inside the user's login interactive shell; the window shows http://127.0.0.1:<port>, the
// same pages a browser shows. WFD_PORT and WFD_DATA_DIR override the port and the data directory (trying the app
// beside another install); install.sh and the self-update pass them with open --env

const launchedAt = Date.now() - process.uptime() * 1000;
const port = Number(process.env.WFD_PORT ?? '7317');
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`WFD_PORT is not a port: ${String(process.env.WFD_PORT)}`);
}
const dataDir = path.resolve(
  process.env.WFD_DATA_DIR ??
    path.join(os.homedir(), 'Library', 'Application Support', 'wf-dashboard', 'data'),
);
// The install root holds data/, logs/, updates/ and the txe-workflow clone install.sh makes
const root = path.dirname(dataDir);
const origin = `http://127.0.0.1:${String(port)}`;
const packageDir = path.join(process.resourcesPath, 'server');
const nodePath = path.join(packageDir, 'bin', 'node');
const logsDir = path.join(root, 'logs');
const serverLog = path.join(logsDir, 'server.log');
const appLog = path.join(logsDir, 'app.log');
// Exit code of a server whose update is ready: the replacement script opens the new app once this one quits
const UPDATE_EXIT_CODE = 75;
const START_TIMEOUT_MS = 120_000;

fs.mkdirSync(logsDir, { recursive: true });
const log = (line: string) => {
  fs.appendFileSync(appLog, `[${new Date().toISOString()}] ${line}\n`);
};

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

// A command's exit code and output; lsof exits with 1 when nothing listens, which is an answer here
function capture(file: string, args: string[]) {
  return new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({ code, stdout });
    });
  });
}

// The last lines of the server's log, shown when it fails to start or exits
function logTail(): string {
  const size = fs.statSync(serverLog).size;
  const length = Math.min(size, 16_384);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(serverLog, 'r');
  fs.readSync(fd, buffer, 0, length, size - length);
  fs.closeSync(fd);
  return buffer.toString('utf8').split('\n').slice(-40).join('\n');
}

// Shown in the window as written
class StartError extends Error {
  constructor(
    message: string,
    readonly fix: string,
  ) {
    super(message);
  }
}

// ---- The server

interface ServerProcess {
  pid: number;
  // Resolves with how it ended ("code 1", "signal SIGKILL")
  exited: Promise<string>;
}

let server: ServerProcess | null = null;
let serving: Promise<void> | null = null;
let stopping = false;

// Resolves once /api/health answers; a server already started by this app is reused
function ensureServer(): Promise<void> {
  if (serving === null) {
    const attempt = startServer();
    serving = attempt;
    // A failed start is shown by the caller; the next window or menu click starts again
    attempt.then(undefined, () => {
      if (serving === attempt) serving = null;
    });
  }
  return serving;
}

// Connection refused means the server is not listening yet; every other failure is an error
function healthy(): Promise<boolean> {
  return fetch(`${origin}/api/health`).then(
    (response) => response.ok,
    (error: unknown) => {
      const cause =
        error instanceof Error ? (error.cause as NodeJS.ErrnoException | undefined) : undefined;
      if (cause?.code === 'ECONNREFUSED') return false;
      throw error;
    },
  );
}

// Whether anything accepts connections on the port: refused means free, so a cold start does not wait for lsof
function portInUse(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') resolve(false);
      else reject(error);
    });
  });
}

async function listenerPids(): Promise<number[]> {
  const { stdout } = await capture('lsof', ['-t', '-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN']);
  return stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(Number);
}

async function stopPid(pid: number) {
  process.kill(pid, 'SIGTERM');
  while ((await capture('kill', ['-0', String(pid)])).code === 0) await sleep(100);
}

async function startServer(): Promise<void> {
  const pids = (await portInUse()) ? await listenerPids() : [];
  for (const pid of pids) {
    const { stdout } = await capture('ps', ['-o', 'command=', '-p', String(pid)]);
    if (!stdout.startsWith(`${nodePath} `)) {
      const { stdout: owner } = await capture('lsof', [
        '-nP',
        `-iTCP:${String(port)}`,
        '-sTCP:LISTEN',
      ]);
      throw new StartError(
        `Port ${String(port)} is already in use:\n${owner}`,
        `Quit the program listening on ${String(port)} (for example a dashboard started from its repository with pnpm start), then open WF Dashboard again.`,
      );
    }
    // This app's own server, left running when an earlier run of the app ended without stopping it
    log(`Stopping the server left running (pid ${String(pid)})`);
    await stopPid(pid);
  }

  const env = [
    `WFD_INSTALL_ROOT=${root}`,
    `WFD_DATA_DIR=${dataDir}`,
    `WFD_PORT=${String(port)}`,
    `WFD_APP_PID=${String(process.pid)}`,
  ];
  const txe = path.join(root, 'txe-workflow');
  if (fs.existsSync(path.join(txe, '.git'))) env.push(`WFD_TXE_WORKFLOW=${txe}`);
  const command = `exec ${[
    'env',
    ...env,
    nodePath,
    path.join(packageDir, 'server', 'dist', 'main.js'),
    '--web',
    path.join(packageDir, 'web', 'dist'),
  ]
    .map(quote)
    .join(' ')}`;
  const shellPath = os.userInfo().shell;
  if (shellPath === null)
    throw new Error(`No login shell is recorded for ${os.userInfo().username}`);
  // A fresh log for each start: the server logs every request
  const out = fs.openSync(serverLog, 'w');
  // The login interactive shell reads ~/.zshrc, where PATH, MAGI_VAULT and proxy settings live; exec keeps one process
  const child = spawn(shellPath, ['-l', '-i', '-c', command], {
    cwd: path.join(packageDir, 'server'),
    stdio: ['ignore', out, out],
  });
  fs.closeSync(out);
  const pid = child.pid;
  if (pid === undefined) throw new Error(`${shellPath} did not start`);
  const exited = new Promise<string>((resolve) => {
    child.once('exit', (code, signal) => {
      resolve(code === null ? `signal ${String(signal)}` : `code ${String(code)}`);
    });
  });
  const current: ServerProcess = { pid, exited };
  server = current;
  log(`Started the server (pid ${String(pid)}) on ${origin} with data in ${dataDir}`);
  void exited.then((how) => {
    onServerExit(current, how);
  });

  const progress: { ended: string | null } = { ended: null };
  void exited.then((how) => {
    progress.ended = how;
  });
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (!(await healthy())) {
    if (progress.ended !== null) {
      throw new StartError(
        `The server exited with ${progress.ended} before answering. Last lines of ${serverLog}:\n${logTail()}`,
        'Fix the error above, then open WF Dashboard again.',
      );
    }
    if (Date.now() > deadline) {
      await stopServer();
      throw new StartError(
        `The server did not answer ${origin}/api/health within 2 minutes and was stopped. Last lines of ${serverLog}:\n${logTail()}`,
        'Fix the error above, then open WF Dashboard again.',
      );
    }
    await sleep(50);
  }
  log(`The server answers after ${String(Date.now() - launchedAt)} ms since launch`);
}

function onServerExit(ended: ServerProcess, how: string) {
  if (server !== ended) return;
  server = null;
  serving = null;
  log(`The server exited with ${how}`);
  if (how === `code ${String(UPDATE_EXIT_CODE)}`) {
    log('Quitting for the update; the replacement script opens the new version');
    app.exit(0);
    return;
  }
  if (stopping) return;
  if (mainWindow !== null) {
    showError(
      mainWindow,
      new StartError(
        `The server exited with ${how}. Last lines of ${serverLog}:\n${logTail()}`,
        'Use Open WF Dashboard in the menu bar to start it again.',
      ),
    );
  }
}

async function stopServer() {
  const running = server;
  if (running === null) return;
  stopping = true;
  process.kill(running.pid, 'SIGTERM');
  await running.exited;
  stopping = false;
}

// ---- The window

let mainWindow: BrowserWindow | null = null;

const isOwnPage = (target: string) => URL.canParse(target) && new URL(target).origin === origin;

const escapeHtml = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function showError(win: BrowserWindow, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const fix = error instanceof StartError ? error.fix : '';
  log(`Error shown: ${message}`);
  const html = `<!doctype html><meta charset="utf-8"><title>WF Dashboard</title>
<style>:root{color-scheme:light dark}body{font:14px -apple-system,system-ui,sans-serif;margin:32px}pre{white-space:pre-wrap;font:12px ui-monospace,Menlo,monospace;padding:12px;border-radius:6px;background:color-mix(in srgb,currentColor 8%,transparent)}</style>
<h3>WF Dashboard could not start</h3><pre>${escapeHtml(message)}</pre><p>${escapeHtml(fix)}</p>`;
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

// Shows the window, starting the server first when it is not running. The window is created at once (its renderer
// starts while the server does) and appears once the page has painted
async function showWindow(openedAt: number) {
  if (mainWindow !== null) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  const { workAreaSize } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    width: Math.min(1600, workAreaSize.width),
    height: Math.min(1000, workAreaSize.height),
    minWidth: 800,
    minHeight: 500,
    show: false,
    title: 'WF Dashboard',
  });
  mainWindow = win;
  const warm = server !== null;
  win.once('ready-to-show', () => {
    win.show();
    log(
      `Window shown ${String(Date.now() - openedAt)} ms after opening (${warm ? 'server already running' : 'server started'})`,
    );
  });
  win.on('closed', () => {
    mainWindow = null;
    app.dock?.hide();
  });
  // Links to other sites open in the system browser; the dashboard's own pages stay in the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isOwnPage(url)) return { action: 'allow' };
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isOwnPage(url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
  void app.dock?.show();
  await ensureServer().then(
    () => win.loadURL(origin),
    (error: unknown) => {
      showError(win, error);
    },
  );
}

// ---- Quitting

let quitConfirmed = false;
let quitAsked = false;

// Running runs and local interactive processes stop with the server: ask first (Contracts 39.2a)
async function confirmAndQuit() {
  if (quitAsked) return;
  quitAsked = true;
  if (server !== null && (await healthy())) {
    const response = await fetch(`${origin}/api/install/running`);
    const { running } = (await response.json()) as { running: string[] };
    if (running.length > 0) {
      const answer = await dialog.showMessageBox({
        type: 'warning',
        message: 'Quit WF Dashboard?',
        detail: `Quitting stops the dashboard and what is still running:\n\n${running.join('\n')}`,
        buttons: ['Quit', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      });
      if (answer.response === 1) {
        quitAsked = false;
        return;
      }
    }
  }
  await stopServer();
  log('Quit');
  quitConfirmed = true;
  app.quit();
}

// ---- Startup

// uninstall.sh runs the app once with this flag to remove the login item
const unregister = process.argv.includes('--unregister-login-item');

if (!unregister && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // With no server there is nothing to ask about or stop; otherwise the quit waits for the answer and the server
  app.on('before-quit', (event) => {
    if (quitConfirmed || unregister || server === null) return;
    event.preventDefault();
    void confirmAndQuit();
  });
  // Closing the window keeps the server running; the menu bar icon opens it again
  app.on('window-all-closed', () => undefined);
  app.on('activate', () => {
    void showWindow(Date.now());
  });
  app.on('second-instance', () => {
    void showWindow(Date.now());
  });
  process.once('SIGTERM', () => {
    app.quit();
  });

  void app.whenReady().then(() => {
    if (unregister) {
      app.setLoginItemSettings({ openAtLogin: false });
      log(`Login item removed: ${JSON.stringify(app.getLoginItemSettings())}`);
      app.exit(0);
      return;
    }
    // Start at login without a window (Contracts 39.2a); a login item the user turned off (requires-approval) stays off
    const login = app.getLoginItemSettings();
    if (login.status === 'not-registered' || login.status === 'not-found') {
      app.setLoginItemSettings({ openAtLogin: true });
    }
    log(
      `Launched from ${app.getAppPath()}; login item: ${JSON.stringify(app.getLoginItemSettings())}`,
    );

    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
      ]),
    );
    const icon = nativeImage.createFromPath(
      path.join(app.getAppPath(), 'assets', 'trayTemplate.png'),
    );
    icon.setTemplateImage(true);
    const tray = new Tray(icon);
    tray.setToolTip('WF Dashboard');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: 'Open WF Dashboard',
          click: () => {
            void showWindow(Date.now());
          },
        },
        { type: 'separator' },
        {
          label: 'Quit WF Dashboard',
          click: () => {
            app.quit();
          },
        },
      ]),
    );

    if (login.wasOpenedAtLogin) {
      app.dock?.hide();
      void ensureServer().then(undefined, (error: unknown) => {
        log(
          `Starting the server at login failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      return;
    }
    void showWindow(launchedAt);
  });
}
