import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { execa } from 'execa';

// Builds the release package of Contracts 39.2 into .work/release/: wf-dashboard-<version>-darwin-arm64.tar.gz and
// install.sh. With --publish --commit <sha> it then creates the GitHub Release v<version> on txehq/wf-dashboard at that
// commit (the snapshot commit .work/publish-github.sh pushed) and uploads both files.
//   pnpm release
//   pnpm release --publish --commit <sha>

const REPO = 'txehq/wf-dashboard';
const INSTALL_COMMAND = `gh release download --repo ${REPO} --pattern install.sh --output - | bash`;

const { values } = parseArgs({
  options: { publish: { type: 'boolean', default: false }, commit: { type: 'string' } },
});
if (values.publish && values.commit === undefined) {
  throw new Error('--publish needs --commit <sha>: the commit on GitHub the Release points at');
}

const root = path.resolve(import.meta.dirname, '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  version: unknown;
};
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`The version in package.json is not x.y.z: ${String(version)}`);
}
const name = `wf-dashboard-${version}`;
const asset = `${name}-darwin-arm64.tar.gz`;
const out = path.join(root, '.work', 'release');
const stage = path.join(out, 'stage', name);
const deployDir = path.join(out, 'deploy');

const log = (line: string) => {
  console.log(`[release] ${line}`);
};
const run = (file: string, args: string[], cwd = root) =>
  execa(file, args, { cwd, stdio: 'inherit', env: { COPYFILE_DISABLE: '1' } });

// The bundled Node is the one running this script: Node 22 on darwin-arm64, the platform of the package
if (
  !process.version.startsWith('v22.') ||
  process.platform !== 'darwin' ||
  process.arch !== 'arm64'
) {
  throw new Error(
    `The package bundles the Node that runs this script, which must be Node 22 on darwin-arm64; this is ${process.version} on ${process.platform}-${process.arch} (${process.execPath})`,
  );
}

const status = await execa('git', ['status', '--porcelain'], { cwd: root });
const dirty = status.stdout.trim() !== '';
if (values.publish && dirty) {
  throw new Error(`Publishing needs a clean working tree; uncommitted changes:\n${status.stdout}`);
}
const head = (await execa('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();

log(`Building ${name} from ${head}${dirty ? ' with uncommitted changes' : ''}`);
await run('pnpm', ['build']);

// Production dependencies only, with native modules installed for this Node
fs.rmSync(deployDir, { recursive: true, force: true });
await run('pnpm', ['--filter', '@wf-dashboard/server', 'deploy', '--prod', deployDir]);

fs.rmSync(path.join(out, 'stage'), { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
const copy = (from: string, to = from) => {
  fs.cpSync(path.join(root, from), path.join(stage, to), {
    recursive: true,
    verbatimSymlinks: true,
    // Temporary clones a bundle build leaves in tasks/ when it stops midway
    filter: (source) => !path.basename(source).startsWith('.bundle-tmp-'),
  });
};
for (const entry of [
  'package.json',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'agent/MAGI.md',
  'tasks',
  'web/dist',
  'server/package.json',
  'server/dist',
  // The server reads the built-in workflows and skills from server/src/workflows/, and Magi Agent reads the sources
  'server/src',
  'server/drizzle',
  'server/remote-scripts',
]) {
  copy(entry);
}
copy('release/uninstall.sh', 'uninstall.sh');
fs.writeFileSync(
  path.join(stage, 'install.sh'),
  fs.readFileSync(path.join(root, 'release/install.sh'), 'utf8').replaceAll('@VERSION@', version),
  { mode: 0o755 },
);
fs.renameSync(path.join(deployDir, 'node_modules'), path.join(stage, 'server', 'node_modules'));
fs.rmSync(deployDir, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, 'bin'));
fs.copyFileSync(process.execPath, path.join(stage, 'bin', 'node'));
fs.chmodSync(path.join(stage, 'bin', 'node'), 0o755);
fs.writeFileSync(
  path.join(stage, 'release.json'),
  `${JSON.stringify({ version, commit: dirty ? `${head}-dirty` : head, builtAt: new Date().toISOString() }, null, 2)}\n`,
);

// Prebuilt native binaries for other platforms are never loaded on darwin-arm64
const store = path.join(stage, 'server', 'node_modules', '.pnpm');
let pruned = 0;
for (const entry of fs.readdirSync(store, { recursive: true, encoding: 'utf8' })) {
  if (path.basename(entry) !== 'prebuilds') continue;
  const dir = path.join(store, entry);
  for (const platform of fs.readdirSync(dir)) {
    if (platform.startsWith('darwin-arm64')) continue;
    fs.rmSync(path.join(dir, platform), { recursive: true, force: true });
    pruned += 1;
  }
}
log(`Removed ${String(pruned)} prebuilt binaries for other platforms`);

log('Loading every native module with the bundled Node');
await run(path.join(stage, 'bin', 'node'), [
  path.join(stage, 'server', 'dist', 'install', 'check-native.js'),
]);

const tarball = path.join(out, asset);
const installer = path.join(out, 'install.sh');
fs.rmSync(tarball, { force: true });
await run('tar', ['-czf', tarball, '-C', path.dirname(stage), name]);
fs.copyFileSync(path.join(stage, 'install.sh'), installer);
const mb = (file: string) => (fs.statSync(file).size / 1024 / 1024).toFixed(1);
log(`${tarball} (${mb(tarball)} MB)`);
log(installer);

if (values.publish && values.commit !== undefined) {
  const notes = `Install (macOS on Apple Silicon, gh logged in as a member of txehq, Claude Code and the Magi workflow installed):\n\n\`\`\`sh\n${INSTALL_COMMAND}\n\`\`\`\n\nThen open http://127.0.0.1:7317. Installed dashboards update themselves to this release.`;
  await run('gh', [
    'release',
    'create',
    `v${version}`,
    '--repo',
    REPO,
    '--target',
    values.commit,
    '--title',
    `wf-dashboard ${version}`,
    '--notes',
    notes,
    tarball,
    installer,
  ]);
  log(`Published v${version} on ${REPO}`);
}
