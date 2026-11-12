import fs from 'node:fs';
import path from 'node:path';

// data/ at the repo root is the user instance's data directory: a test run must add no entries to data/runs or data/variants and no db.sqlite* files
const data = path.resolve(import.meta.dirname, '../../../data');

function entries(): Set<string> {
  const out = new Set<string>();
  for (const sub of ['runs', 'variants']) {
    const dir = path.join(data, sub);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) out.add(path.join(dir, name));
  }
  if (fs.existsSync(data)) {
    for (const name of fs.readdirSync(data)) {
      if (name.startsWith('db.sqlite')) out.add(path.join(data, name));
    }
  }
  return out;
}

export function setup() {
  const before = entries();
  return () => {
    const added = [...entries()].filter((p) => !before.has(p)).sort();
    if (added.length > 0) {
      throw new Error(
        `Tests wrote to data/ at the repo root (the user instance's data directory):\n${added.join('\n')}`,
      );
    }
  };
}
