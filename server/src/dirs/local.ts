import { lstat, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from '../variants/errors.js';
import { type DirList, existsMessage, folderNameProblem, type NewDir } from './views.js';

// Local directory browsing and folder creation (Contracts 34.1): the working directory of a real environment in Live's new interactive dialog, starting at home; shares the component with the remote dialog

function absolute(dir: string): string {
  if (!path.isAbsolute(dir)) throw new HttpError(400, `Must be an absolute path: ${dir}`);
  return path.resolve(dir);
}

export function createLocalDirs(deps: { home: string }) {
  return {
    // Empty dir means home; a missing or unreadable directory yields readdir's own error
    async list(dir: string): Promise<DirList> {
      const resolved = absolute(dir === '' ? deps.home : dir);
      const names = (await readdir(resolved, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
      return {
        path: resolved,
        parent: resolved === path.parse(resolved).root ? null : path.dirname(resolved),
        dirs: names,
      };
    },
    // Not recursive; 400 for an invalid name, 409 if it exists, mkdir's own error when it fails (e.g. no permission)
    async mkdir(parent: string, name: string): Promise<NewDir> {
      const problem = folderNameProblem(name);
      if (problem !== null) throw new HttpError(400, problem);
      const target = path.join(absolute(parent), name);
      const existing = await lstat(target).then(
        () => true,
        (error: unknown) => {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ENOTDIR') return false;
          throw error;
        },
      );
      if (existing) throw new HttpError(409, existsMessage(target));
      await mkdir(target);
      return { path: target };
    },
  };
}

export type LocalDirs = ReturnType<typeof createLocalDirs>;
