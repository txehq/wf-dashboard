import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { HttpError } from './errors.js';

// 任意 workflow 的 variant 安装到本机（Contracts 18.6）：skill 复制进用户自己的 ~/.claude/skills（Claude Code）
// 与 ~/.agents/skills（Codex），清单写在 data/installs/<variantId>.json。同一 workflow 同一时间只装一个 variant

export const InstallManifest = z.object({
  variantId: z.string(),
  variantName: z.string(),
  workflowId: z.string(),
  installedAt: z.number(),
  // 两个目标目录
  targets: z.object({ claude: z.string(), agents: z.string() }),
  // 建出的 skill 目录（目标目录/<名字>）
  dirs: z.array(z.string()),
  // 复制的每个文件的绝对路径与 sha256
  files: z.array(z.object({ path: z.string(), sha256: z.string() })),
});
export type InstallManifest = z.infer<typeof InstallManifest>;

const sha256 = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function filesUnder(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

// 自下而上删去 dir 中的空目录，最后是 dir 本身（还有文件时保留）
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
        if (manifest === null) throw new Error(`安装清单消失了：${name}`);
        return manifest;
      });
  }

  // 按清单删除文件与空目录；文件被改过（sha256 不同）时拒绝并列出。已经不存在的文件不再删除
  function uninstall(variantId: string): InstallManifest {
    const manifest = read(variantId);
    if (manifest === null) throw new HttpError(404, `variant ${variantId} 没有装在本机`);
    const changed = manifest.files.filter(
      (f) => fs.existsSync(f.path) && sha256(f.path) !== f.sha256,
    );
    if (changed.length > 0) {
      throw new HttpError(
        409,
        `这些文件在安装后被改过，没有卸载（先把改动移走或恢复原样）：\n${changed.map((f) => f.path).join('\n')}`,
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

    // skillsDir 中每个 skill 目录复制到两个目标目录。目标中已有同名目录、且不是为同一 workflow 装的：拒绝并列出；
    // 同一 workflow 已经装了 variant（含这一个）时先按它的清单卸载
    install(variant: { id: string; name: string; workflowId: string }, skillsDir: string) {
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
          `这些目录已经存在，不是 dashboard 为 workflow ${variant.workflowId} 装的，没有覆盖：\n${conflicts.join('\n')}`,
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
        variantName: variant.name,
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
  };
}

export type LocalInstalls = ReturnType<typeof createLocalInstalls>;
