import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { packager } from '@electron/packager';
import { Resvg } from '@resvg/resvg-js';
import { execa } from 'execa';

// Builds the release of Contracts 39.2 into .work/release/: WF Dashboard.app (Electron, ad-hoc signed) with the server
// package in Contents/Resources/server/, zipped as WF-Dashboard-<version>-arm64.zip, and install.sh. With --publish
// --commit <sha> it then creates the GitHub Release v<version> on txehq/wf-dashboard at that commit (the snapshot
// commit .work/publish-github.sh pushed) and uploads both files.
//   pnpm release
//   pnpm release --publish --commit <sha>

const REPO = 'txehq/wf-dashboard';
const APP_NAME = 'WF Dashboard';
const BUNDLE_ID = 'dev.engapp.wf-dashboard';
const INSTALL_COMMAND = `gh release download --repo ${REPO} --pattern install.sh --output - | bash`;

const { values } = parseArgs({
  options: { publish: { type: 'boolean', default: false }, commit: { type: 'string' } },
});
if (values.publish && values.commit === undefined) {
  throw new Error('--publish needs --commit <sha>: the commit on GitHub the Release points at');
}

const root = path.resolve(import.meta.dirname, '..');
const readVersion = (file: string) =>
  (JSON.parse(fs.readFileSync(file, 'utf8')) as { version: unknown }).version;
const version = readVersion(path.join(root, 'package.json'));
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`The version in package.json is not x.y.z: ${String(version)}`);
}
const electronVersion = readVersion(
  path.join(root, 'desktop', 'node_modules', 'electron', 'package.json'),
);
if (typeof electronVersion !== 'string') throw new Error('desktop/ has no electron installed');
const asset = `WF-Dashboard-${version}-arm64.zip`;
const out = path.join(root, '.work', 'release');
const stage = path.join(out, 'stage');
const serverStage = path.join(stage, 'server');
const appSource = path.join(stage, 'app-source');
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

log(`Building ${APP_NAME} ${version} from ${head}${dirty ? ' with uncommitted changes' : ''}`);
await run('pnpm', ['build']);

// Production dependencies only, with native modules installed for this Node
fs.rmSync(deployDir, { recursive: true, force: true });
await run('pnpm', ['--filter', '@wf-dashboard/server', 'deploy', '--prod', deployDir]);

// ---- The server package (Contents/Resources/server/)
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(serverStage, { recursive: true });
const copy = (from: string, to = from) => {
  fs.cpSync(path.join(root, from), path.join(serverStage, to), {
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
  // The server reads the built-in workflows and skills from server/src/workflows/, the update its replacement script
  // from server/src/install/, and Magi Agent reads the sources
  'server/src',
  'server/drizzle',
  'server/remote-scripts',
]) {
  copy(entry);
}
fs.renameSync(
  path.join(deployDir, 'node_modules'),
  path.join(serverStage, 'server', 'node_modules'),
);
fs.rmSync(deployDir, { recursive: true, force: true });
fs.mkdirSync(path.join(serverStage, 'bin'));
fs.copyFileSync(process.execPath, path.join(serverStage, 'bin', 'node'));
fs.chmodSync(path.join(serverStage, 'bin', 'node'), 0o755);
fs.writeFileSync(
  path.join(serverStage, 'release.json'),
  `${JSON.stringify({ version, commit: dirty ? `${head}-dirty` : head, builtAt: new Date().toISOString() }, null, 2)}\n`,
);

// Prebuilt native binaries for other platforms are never loaded on darwin-arm64
const store = path.join(serverStage, 'server', 'node_modules', '.pnpm');
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
await run(path.join(serverStage, 'bin', 'node'), [
  path.join(serverStage, 'server', 'dist', 'install', 'check-native.js'),
]);

// ---- The app (desktop/): its built main process, the menu bar icon and the app icon rendered from SVG
const render = (svg: string, width: number, file: string) => {
  const png = new Resvg(fs.readFileSync(path.join(root, 'desktop', 'assets', svg)), {
    fitTo: { mode: 'width', value: width },
  })
    .render()
    .asPng();
  fs.writeFileSync(file, png);
};
fs.mkdirSync(path.join(appSource, 'assets'), { recursive: true });
fs.cpSync(path.join(root, 'desktop', 'dist'), path.join(appSource, 'dist'), { recursive: true });
fs.writeFileSync(
  path.join(appSource, 'package.json'),
  `${JSON.stringify({ name: 'wf-dashboard', productName: APP_NAME, version, type: 'module', main: 'dist/main.js' }, null, 2)}\n`,
);
render('tray.svg', 16, path.join(appSource, 'assets', 'trayTemplate.png'));
render('tray.svg', 32, path.join(appSource, 'assets', 'trayTemplate@2x.png'));
const iconset = path.join(stage, 'icon.iconset');
fs.mkdirSync(iconset);
for (const size of [16, 32, 128, 256, 512]) {
  render('icon.svg', size, path.join(iconset, `icon_${String(size)}x${String(size)}.png`));
  render('icon.svg', size * 2, path.join(iconset, `icon_${String(size)}x${String(size)}@2x.png`));
}
const icon = path.join(stage, 'icon.icns');
await run('iconutil', ['-c', 'icns', iconset, '-o', icon]);

const packaged = path.join(out, 'packaged');
fs.rmSync(packaged, { recursive: true, force: true });
const [appDir] = await packager({
  dir: appSource,
  out: packaged,
  name: APP_NAME,
  platform: 'darwin',
  arch: 'arm64',
  electronVersion,
  appVersion: version,
  buildVersion: version,
  appBundleId: BUNDLE_ID,
  appCategoryType: 'public.app-category.developer-tools',
  icon,
  asar: true,
  prune: false,
  overwrite: true,
});
if (appDir === undefined) throw new Error('electron packager produced no app');
const appPath = path.join(appDir, `${APP_NAME}.app`);
const resources = path.join(appPath, 'Contents', 'Resources');
fs.renameSync(serverStage, path.join(resources, 'server'));
fs.copyFileSync(path.join(root, 'release', 'uninstall.sh'), path.join(resources, 'uninstall.sh'));
fs.chmodSync(path.join(resources, 'uninstall.sh'), 0o755);

// Ad-hoc signature over the whole bundle, the server package included
log('Signing the app ad hoc');
await run('codesign', ['--force', '--deep', '--sign', '-', appPath]);
await run('codesign', ['--verify', '--deep', '--strict', appPath]);

const zip = path.join(out, asset);
const installer = path.join(out, 'install.sh');
fs.rmSync(zip, { force: true });
await run('ditto', ['-c', '-k', '--keepParent', appPath, zip]);
fs.writeFileSync(
  installer,
  fs
    .readFileSync(path.join(root, 'release', 'install.sh'), 'utf8')
    .replaceAll('@VERSION@', version),
  { mode: 0o755 },
);
const mb = (file: string) => (fs.statSync(file).size / 1024 / 1024).toFixed(1);
log(`${zip} (${mb(zip)} MB)`);
log(installer);

if (values.publish && values.commit !== undefined) {
  const notes = `Install (macOS on Apple Silicon, gh logged in as a member of txehq, Claude Code and the Magi workflow installed):\n\n\`\`\`sh\n${INSTALL_COMMAND}\n\`\`\`\n\nThis installs ${APP_NAME} in /Applications and opens it. Installed apps update themselves to this release.`;
  await run('gh', [
    'release',
    'create',
    `v${version}`,
    '--repo',
    REPO,
    '--target',
    values.commit,
    '--title',
    `${APP_NAME} ${version}`,
    '--notes',
    notes,
    zip,
    installer,
  ]);
  log(`Published v${version} on ${REPO}`);
}
