import { execFileSync } from 'node:child_process';
import path from 'node:path';

// 真实样本在主仓库的 .spikes/stage-markers/samples/（Stage Markers 第 4 节），worktree 经 git common dir 找到主仓库
const mainRepo = path.dirname(
  path.resolve(execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim()),
);
export const samplesDir = path.join(mainRepo, '.spikes', 'stage-markers', 'samples');

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
