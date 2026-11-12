import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { HttpError } from './errors.js';

// Installs a variant of any workflow on this machine (Contracts 18.6): skills are copied into the user's own ~/.claude/skills (Claude Code)
// and ~/.agents/skills (Codex), with the manifest in data/installs/<variantId>.json. One variant per workflow at a time

// The manifest does not store the variant name (Contracts 16.4, the current name is read by id after a rename); variantName in old manifests is dropped on read
export const InstallManifest = z.object({
  variantId: z.string(),
  workflowId: z.string(),
  installedAt: z.number(),
  // The two target directories
  targets: z.object({ claude: z.string(), agents: z.string() }),
  // Created skill directories (target/<name>)
  dirs: z.array(z.string()),
  // Absolute path and sha256 of every copied file
  files: z.array(z.object({ path: z.string(), sha256: z.string() })),
});
export type InstallManifest = z.infer<typeof InstallManifest>;

// The manifest returned by the API: plus the variant's current name
export const InstallView = InstallManifest.extend({ variantName: z.string() });
export type InstallView = z.infer<typeof InstallView>;

const sha256 = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function filesUnder(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

// Removes empty directories in dir bottom-up, finally dir itself (kept while it still has files)
function removeEmptyDirs(dir: string) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirs(path.join(dir, entry.name));
  }
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

export function createLocalInstalls({ installsDir, home }: { installsDir: string; home: string }) {
  const targets = {
    claude: path.join(home, '.claude', 'skills'),
    agents: path.join(home, '.agents', 'skills'),
  };
  const manifestFile = (variantId: string) => path.join(installsDir, `${variantId}.json`);

  function read(variantId: string): InstallManifest | null {
    const file = manifestFile(variantId);
    if (!fs.existsSync(file)) return null;
    return InstallManifest.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  }

  function all(): InstallManifest[] {
    if (!fs.existsSync(installsDir)) return [];
    return fs
      .readdirSync(installsDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const manifest = read(name.slice(0, -'.json'.length));
        if (manifest === null) throw new Error(`Install manifest disappeared: ${name}`);
        return manifest;
      });
  }

  // Files changed after install (different sha256) when installed on this machine; empty when not installed
  function modifiedFiles(variantId: string): string[] {
    const manifest = read(variantId);
    if (manifest === null) return [];
    return manifest.files
      .filter((f) => fs.existsSync(f.path) && sha256(f.path) !== f.sha256)
      .map((f) => f.path);
  }

  // Deletes the manifest's files and empty directories; refuses and lists files changed since install (different sha256). Files already gone are skipped
  function uninstall(variantId: string): InstallManifest {
    const manifest = read(variantId);
    if (manifest === null)
      throw new HttpError(404, `Variant ${variantId} is not installed on this machine`);
    const changed = modifiedFiles(variantId);
    if (changed.length > 0) {
      throw new HttpError(
        409,
        `These files were changed after install, so nothing was uninstalled (move the changes away or restore them first):\n${changed.join('\n')}`,
      );
    }
    for (const f of manifest.files) fs.rmSync(f.path, { force: true });
    for (const dir of manifest.dirs) removeEmptyDirs(dir);
    fs.rmSync(manifestFile(variantId));
    return manifest;
  }

  return {
    targets,

    status: read,

    // Copies every skill directory of skillsDir into both targets. A same-named directory in a target not installed for this workflow: refuse and list;
    // when this workflow already has a variant installed (this one included), uninstall it by its manifest first
    install(variant: { id: string; workflowId: string }, skillsDir: string) {
      const names = fs
        .readdirSync(skillsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      const sameWorkflow = all().filter((m) => m.workflowId === variant.workflowId);
      const owned = new Set(sameWorkflow.flatMap((m) => m.dirs));
      const conflicts = Object.values(targets)
        .flatMap((root) => names.map((name) => path.join(root, name)))
        .filter((dir) => fs.existsSync(dir) && !owned.has(dir));
      if (conflicts.length > 0) {
        throw new HttpError(
          409,
          `These directories already exist and were not installed by the dashboard for workflow ${variant.workflowId}, so nothing was overwritten:\n${conflicts.join('\n')}`,
        );
      }
      const replaced = sameWorkflow.map((m) => uninstall(m.variantId));
      const dirs: string[] = [];
      const files: InstallManifest['files'] = [];
      for (const root of Object.values(targets)) {
        fs.mkdirSync(root, { recursive: true });
        for (const name of names) {
          const dir = path.join(root, name);
          fs.cpSync(path.join(skillsDir, name), dir, {
            recursive: true,
            errorOnExist: true,
            force: false,
          });
          dirs.push(dir);
          files.push(...filesUnder(dir).map((file) => ({ path: file, sha256: sha256(file) })));
        }
      }
      const manifest: InstallManifest = {
        variantId: variant.id,
        workflowId: variant.workflowId,
        installedAt: Date.now(),
        targets,
        dirs,
        files,
      };
      fs.mkdirSync(installsDir, { recursive: true });
      fs.writeFileSync(manifestFile(variant.id), `${JSON.stringify(manifest, null, 2)}\n`);
      return { manifest, replaced };
    },

    uninstall,
    modifiedFiles,
  };
}

export type LocalInstalls = ReturnType<typeof createLocalInstalls>;
