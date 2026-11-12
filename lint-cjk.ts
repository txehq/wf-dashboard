import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execa } from 'execa';

// Part of pnpm lint (Contracts 36.3): no Chinese characters (U+3000-U+303F, U+4E00-U+9FFF, U+FF00-U+FFEF)
// in tracked files. Text files are checked as git sees them (binary files are skipped by git's judgement);
// compressed test data is unpacked first: .gz is decompressed, .sqlite.gz is dumped with sqlite3,
// .bundle is cloned into a bare repository whose commit messages and files are checked.
// Prints file and line of every hit and exits with 1.
const root = import.meta.dirname;
const work = path.join(root, '.work', 'lint-cjk');
const RANGES: [number, number][] = [
  [0x3000, 0x303f],
  [0x4e00, 0x9fff],
  [0xff00, 0xffef],
];
const CJK = new RegExp(
  `[${RANGES.map(([a, b]) => `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`).join('')}]`,
);
const PCRE = `[${RANGES.map(([a, b]) => `\\x{${a.toString(16)}}-\\x{${b.toString(16)}}`).join('')}]`;
const env = { LC_ALL: 'en_US.UTF-8' };
const hits: string[] = [];

// git grep -z -n prints "file\0line\0text"; exit code 1 means no match
async function grep(cwd: string, revs: string[], label: (file: string) => string) {
  const out = await execa('git', ['grep', '-I', '-z', '-n', '-P', PCRE, ...revs], {
    cwd,
    env,
    reject: false,
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (out.exitCode !== 0 && out.exitCode !== 1) throw new Error(out.stderr);
  for (const line of out.stdout.split('\n').filter(Boolean)) {
    const match = /^([^\0]*)\0(\d+)\0/.exec(line);
    if (!match?.[1] || !match[2]) throw new Error(`Unexpected git grep output: ${line}`);
    hits.push(`${label(match[1])}:${match[2]}`);
  }
}

function lines(file: string, text: string) {
  text.split('\n').forEach((line, i) => {
    if (CJK.test(line)) hits.push(`${file}:${String(i + 1)}`);
  });
}

const tracked = async (glob: string) =>
  (await execa('git', ['ls-files', '-z', '--', glob], { cwd: root })).stdout
    .split('\0')
    .filter(Boolean);

await grep(root, [], (file) => file);

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

for (const file of await tracked('*.gz')) {
  const data = zlib.gunzipSync(fs.readFileSync(path.join(root, file)));
  if (file.endsWith('.sqlite.gz')) {
    const db = path.join(work, 'dump.sqlite');
    fs.writeFileSync(db, data);
    lines(file, (await execa('sqlite3', [db, '.dump'], { maxBuffer: 1024 * 1024 * 1024 })).stdout);
    fs.rmSync(db);
    continue;
  }
  // the same test git uses: a NUL byte in the first 8000 bytes means binary
  if (data.subarray(0, 8000).includes(0)) continue;
  lines(file, data.toString('utf8'));
}

for (const file of await tracked('*.bundle')) {
  const repo = path.join(work, 'bundle.git');
  await execa('git', ['clone', '--bare', '--quiet', path.join(root, file), repo]);
  // %x00 after the hash and after the message: hash and message alternate
  const log = await execa('git', ['log', '--all', '--format=%H%x00%B%x00'], { cwd: repo });
  const parts = log.stdout.split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [hash = '', message = ''] = parts.slice(i, i + 2);
    if (CJK.test(message)) hits.push(`${file}: message of commit ${hash.trim()}`);
  }
  const revs = (await execa('git', ['rev-list', '--all'], { cwd: repo })).stdout.split('\n');
  await grep(repo, revs, (revPath) => `${file}: ${revPath}`);
  fs.rmSync(repo, { recursive: true });
}

if (hits.length) {
  console.error(`Chinese characters in tracked files (Contracts 36):\n${hits.join('\n')}`);
  process.exit(1);
}
