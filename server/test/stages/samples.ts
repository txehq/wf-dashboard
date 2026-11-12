import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// Real samples (Stage Markers section 4) are stored gzipped file by file under test/fixtures/samples/<project dir>/
// (main jsonl, subagents, tool-results) and unpacked into the repo's .work/samples/ with the same layout when this
// module is imported. Several test processes may unpack at once: each file is first written to the process's own
// temp file outside the samples directory and then renamed, so readers never see half-written files; files already
// unpacked and not older than the fixture are skipped
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
