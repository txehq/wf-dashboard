// The arguments after out/server-main.js for a server on this machine or an SSH host. No workspace trust prompt: the
// dashboard opens only its own Live items' working directories, where the agent is already running; the trust prompt
// also makes built-in extensions such as git-base run in the browser, where they fail to load (the package has no
// browser build of them, measured in W97). The server-side messages are in English (Contracts 36.1); the page's
// language comes from the vscode.nls.locale cookie the dashboard sets before opening it
export function serverArgs(o: {
  port: number;
  tokenFile: string;
  serverDataDir: string;
}): string[] {
  return [
    '--host',
    '127.0.0.1',
    '--port',
    String(o.port),
    '--connection-token-file',
    o.tokenFile,
    '--accept-server-license-terms',
    '--telemetry-level',
    'off',
    '--disable-workspace-trust',
    '--locale',
    'en',
    '--server-data-dir',
    o.serverDataDir,
  ];
}
