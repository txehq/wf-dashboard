import type { Stats } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';

// Filesystem checks on paths the user controls (session working directories, worktrees, project and vault
// directories). They run off the event loop: a folder macOS protects (Desktop, Documents, Downloads) holds its first
// access until the user answers the system dialog, and a slow mount can hold any access; a synchronous call would stop
// the whole server meanwhile (W139)

// ENOENT and ENOTDIR answer "not there"; any other error (EPERM for a folder access was refused to, EACCES) is thrown
const isAbsent = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

export async function statOf(p: string): Promise<Stats | null> {
  return stat(p).catch((error: unknown) => {
    if (isAbsent(error)) return null;
    throw error;
  });
}

export async function pathExists(p: string): Promise<boolean> {
  return (await statOf(p)) !== null;
}

export async function isDirectory(p: string): Promise<boolean> {
  return (await statOf(p))?.isDirectory() ?? false;
}

// The real path; the path itself when it does not exist
export async function realOrSelf(p: string): Promise<string> {
  return realpath(p).catch((error: unknown) => {
    if (isAbsent(error)) return p;
    throw error;
  });
}
