// Monaco language id by skill file extension
export function languageOf(path: string): string {
  if (path.endsWith('.md')) return 'markdown';
  if (path.endsWith('.sh')) return 'shell';
  if (path.endsWith('.py')) return 'python';
  if (path.endsWith('.ts')) return 'typescript';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.yaml') || path.endsWith('.yml')) return 'yaml';
  return 'plaintext';
}
