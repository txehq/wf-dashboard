import { z } from 'zod';

// API shapes for browsing and creating folders (Contracts 31.1, 34.1): the same for remote (/api/ssh-hosts/:id/dirs) and local (/api/local/dirs)

// Subdirectories of one directory
export const DirList = z.object({
  // Resolved absolute path (HOME when no path is given)
  path: z.string(),
  parent: z.string().nullable(),
  dirs: z.array(z.string()),
});
export type DirList = z.infer<typeof DirList>;

// Create a folder named name under parent (absolute path), not recursively
export const NewDirBody = z.object({ parent: z.string().min(1), name: z.string() });
export type NewDirBody = z.infer<typeof NewDirBody>;

export const NewDir = z.object({ path: z.string() });
export type NewDir = z.infer<typeof NewDir>;

// Why a folder name is invalid; null when valid. The server and the dialog use the same rule
export function folderNameProblem(name: string): string | null {
  if (name === '') return 'Name cannot be empty';
  if (name.includes('/')) return 'Name cannot contain /';
  if (name === '.' || name === '..') return 'Name cannot be . or ..';
  if (name.includes('\0')) return 'Name cannot contain a null character';
  return null;
}

export const existsMessage = (path: string) => `Already exists: ${path}`;

// Absolute path (posix) of name under parent
export function childPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
}
