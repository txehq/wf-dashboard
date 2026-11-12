import { execa } from 'execa';
import { HttpError } from '../variants/errors.js';

// Open a Live item's working directory in the user's own VS Code (Contracts section 32): this machine's directories
// through vscode://file, an SSH host's through the Remote - SSH extension (vscode://vscode-remote/ssh-remote+<target>)

export interface VscodeItem {
  cwd: string;
  // The SSH host's target; null for this machine
  hostTarget: string | null;
}

// Each path segment is percent-encoded, so spaces, # and ? stay part of the path
const encodePath = (dir: string) => dir.split('/').map(encodeURIComponent).join('/');

export function vscodeUrl(item: VscodeItem): string {
  return item.hostTarget === null
    ? `vscode://file${encodePath(item.cwd)}`
    : `vscode://vscode-remote/ssh-remote+${item.hostTarget}${encodePath(item.cwd)}`;
}

// macOS open with the vscode:// URL; when VS Code is not installed open fails and its output is the error
export async function openInVscode(item: VscodeItem): Promise<void> {
  const url = vscodeUrl(item);
  const result = await execa('open', [url], { all: true, reject: false });
  if (result.exitCode !== 0) {
    throw new HttpError(500, `open ${url} failed: ${result.all.trim()}`);
  }
}
