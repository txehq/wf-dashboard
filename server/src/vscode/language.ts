import fs from 'node:fs';
import path from 'node:path';

// VS Code for the Web is in English (Contracts 36.1). Before 36.1 the dashboard installed the Chinese language pack into
// server-data (32.4a); it is removed before a server starts, so the workbench and the extensions show English

export const LANGUAGE_PACK_ID = 'ms-ceintl.vscode-language-pack-zh-hans';

// Downloaded language pack vsix files in data/CachedExtensionVSIXs/ start with this (any language)
export const LANGUAGE_PACK_VSIX_PREFIX = 'ms-ceintl.vscode-language-pack-';

// Whether the Chinese language pack is installed (one `<id>@<version>` line of the server's
// --list-extensions --show-versions)
export function hasLanguagePack(listed: string): boolean {
  return listed.split('\n').some((line) => {
    const at = line.trim().lastIndexOf('@');
    return at > 0 && line.trim().slice(0, at).toLowerCase() === LANGUAGE_PACK_ID;
  });
}

// The server's own command line (local or remote) managing the extensions in server-data; the caller adds
// --server-data-dir after args
export type ServerCli = (args: string[]) => Promise<string>;

export async function removeLanguagePack(cli: ServerCli) {
  if (hasLanguagePack(await cli(['--list-extensions', '--show-versions']))) {
    await cli(['--uninstall-extension', LANGUAGE_PACK_ID]);
  }
}

// What uninstalling leaves in server-data/data: languagepacks.json (its entries point at the removed extension, and a
// browser in another language still asks for those translations), the cached vsix files and the generated
// translations under clp/
export function removeLanguagePackData(serverDataDir: string) {
  const data = path.join(serverDataDir, 'data');
  fs.rmSync(path.join(data, 'languagepacks.json'), { force: true });
  fs.rmSync(path.join(data, 'clp'), { recursive: true, force: true });
  const vsixs = path.join(data, 'CachedExtensionVSIXs');
  if (!fs.existsSync(vsixs)) return;
  for (const name of fs.readdirSync(vsixs)) {
    if (name.toLowerCase().startsWith(LANGUAGE_PACK_VSIX_PREFIX)) {
      fs.rmSync(path.join(vsixs, name), { recursive: true, force: true });
    }
  }
}
