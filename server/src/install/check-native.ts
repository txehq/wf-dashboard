import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import * as pty from 'node-pty';
import { Language, Parser } from 'web-tree-sitter';

// Run by a release package's own Node (bin/node server/dist/install/check-native.js) after building, installing and
// downloading an update (Contracts 39.2, 39.4): every package with a darwin-arm64 native binary is loaded and used once.
// A package not listed here fails the check, so a new native dependency cannot ship unchecked

const serverDir = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(serverDir, 'package.json'));

const checks: Record<string, () => Promise<string>> = {
  'better-sqlite3': () => {
    const db = new Database(':memory:');
    const row = db.prepare('select 1 as one').get() as { one: number };
    db.close();
    if (row.one !== 1) throw new Error(`select 1 returned ${JSON.stringify(row)}`);
    return Promise.resolve('select 1 in an in-memory database');
  },
  'node-pty': () =>
    new Promise((resolve, reject) => {
      const child = pty.spawn('/bin/echo', ['pty-ok'], { cols: 80, rows: 24 });
      let output = '';
      child.onData((data) => {
        output += data;
      });
      child.onExit(({ exitCode }) => {
        if (exitCode === 0 && output.includes('pty-ok')) {
          resolve('ran /bin/echo in a pseudo terminal');
        } else {
          reject(new Error(`/bin/echo in a pty exited with ${String(exitCode)}: ${output}`));
        }
      });
    }),
  // The server uses the bundled wasm through web-tree-sitter (stages/shell.ts); its native prebuild is never loaded
  'tree-sitter-bash': async () => {
    await Parser.init();
    const parser = new Parser();
    parser.setLanguage(
      await Language.load(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm')),
    );
    const tree = parser.parse('echo ok');
    if (tree?.rootNode.type !== 'program') {
      throw new Error(`Parsing "echo ok" gave ${String(tree?.rootNode.type)}`);
    }
    return 'parsed a command with the bundled wasm';
  },
};

// Packages in pnpm's virtual store (node_modules/.pnpm/<id>/node_modules/<name>) holding a .node file for this platform
function nativePackages(): string[] {
  const store = path.join(serverDir, 'node_modules', '.pnpm');
  const names = new Set<string>();
  for (const entry of fs.readdirSync(store, { recursive: true, encoding: 'utf8' })) {
    if (!entry.endsWith('.node')) continue;
    if (!entry.includes('darwin-arm64') && !entry.includes('/build/Release/')) continue;
    const parts = entry.split(path.sep);
    const at = parts.indexOf('node_modules');
    const first = parts[at + 1];
    const second = parts[at + 2];
    if (at === -1 || first === undefined || second === undefined) {
      throw new Error(`Cannot tell the package of ${path.join(store, entry)}`);
    }
    names.add(first.startsWith('@') ? `${first}/${second}` : first);
  }
  return [...names].sort();
}

const found = nativePackages();
const unchecked = found.filter((name) => !(name in checks));
if (unchecked.length > 0) {
  throw new Error(
    `Native packages without a check in server/src/install/check-native.ts: ${unchecked.join(', ')}`,
  );
}
for (const [name, check] of Object.entries(checks)) {
  console.log(`ok ${name}: ${await check()}`);
}
console.log(
  `All native modules load with Node ${process.version} (${process.platform}-${process.arch}); found in node_modules: ${found.join(', ')}`,
);
