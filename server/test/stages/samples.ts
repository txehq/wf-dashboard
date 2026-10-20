import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// 真实样本（Stage Markers 第 4 节）逐个文件 gzip 保存在 test/fixtures/samples/<项目目录>/ 下（主 jsonl、子代理、tool-results），
// 导入这个模块时解压到仓库的 .work/samples/，保持原目录结构。多个测试进程可能同时解压：每个文件先写到样本目录之外
// 自己的临时文件再改名，读取方不会读到写了一半的文件；已解压且不比 fixture 旧的文件跳过
const fixture = path.resolve(import.meta.dirname, '../fixtures/samples');
const work = path.resolve(import.meta.dirname, '../../../.work');
export const samplesDir = path.join(work, 'samples');
const partials = path.join(work, 'samples-partial');

fs.mkdirSync(partials, { recursive: true });
for (const entry of fs.readdirSync(fixture, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const from = path.join(entry.parentPath, entry.name);
  const to = path.join(samplesDir, path.relative(fixture, from).replace(/\.gz$/, ''));
  if (fs.existsSync(to) && fs.statSync(to).mtimeMs >= fs.statSync(from).mtimeMs) continue;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const partial = path.join(partials, `${String(process.pid)}-${path.basename(to)}`);
  fs.writeFileSync(partial, zlib.gunzipSync(fs.readFileSync(from)));
  fs.renameSync(partial, to);
}

export const SAMPLES = {
  icPrs: path.join(
    samplesDir,
    '-Users-linhaoz-Project-txe-txe-workflow/f0aca373-863f-4d62-babd-f48055092328.jsonl',
  ),
  research: path.join(
    samplesDir,
    '-Users-linhaoz-Project-txe-txe-workflow/9f4adf2d-0730-4214-994a-4fba7f7b9161.jsonl',
  ),
  interview: path.join(
    samplesDir,
    '-Users-linhaoz-orca-projects-wf-dashboard/d93c4511-3c62-4b3b-8ee6-bf73370cd150.jsonl',
  ),
};
