import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import {
  checksFrom,
  endpointFrom,
  latestPrFrom,
  prInfoFrom,
  readPr,
} from '../src/external/github.js';
import { COPY_COMMIT_TITLE } from '../src/external/github.js';
import { recordedPr } from './helpers/gh-fixtures.js';
import { buildFixtureTask, testRunId } from './helpers/ic-fixture.js';
import { testRepos } from './helpers/local-repos.js';

const repos = testRepos();
const signal = () => new AbortController().signal;

describe('run 的仓库（本地仓库模式）', () => {
  it('ic 副本：起始 commit 之上一个只保留 pull_request 的 commit；workspace clone 在 main 上', async () => {
    const runId = testRunId('w7');
    const task = await buildFixtureTask(runId);
    const created = await repos.createCopy(task, runId, signal());
    expect(fs.existsSync(path.join(config.runsDir, runId, 'seed'))).toBe(false);
    const workspace = path.join(config.runsDir, runId, 'workspace');
    await repos.clone(created.repo, workspace, signal());
    const log = await execa('git', ['-C', workspace, 'log', '--format=%H %P %s']);
    expect(log.stdout.split('\n')[0]).toBe(
      `${created.mainSha} ${task.repo.commit} ${COPY_COMMIT_TITLE}`,
    );
    expect(
      (await execa('git', ['-C', workspace, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout,
    ).toBe('main');
    // 同一个 id 不能建第二次
    await expect(repos.createCopy(task, runId, signal())).rejects.toThrow(
      `本地仓库已存在：${created.repo}`,
    );
  });

  it('lfg 空仓库：只有一个 README 的初始提交，作者 wf-dashboard', async () => {
    const runId = testRunId('w7-lfg');
    const created = await repos.createEmpty(runId, signal());
    const workspace = path.join(config.runsDir, runId, 'workspace');
    await repos.clone(created.repo, workspace, signal());
    expect(fs.readdirSync(workspace).sort()).toEqual(['.git', 'README.md']);
    expect(fs.readFileSync(path.join(workspace, 'README.md'), 'utf8')).toBe(`# wfe-${runId}\n`);
    expect(
      (await execa('git', ['-C', workspace, 'log', '--format=%H %an %s'])).stdout.split('\n'),
    ).toEqual([`${created.mainSha} wf-dashboard chore: initial commit`]);
  });
});

// 录下的真实 gh 输出（scripts/record-gh-fixtures.ts）
describe('PR、checks 与终点（录下的 gh 输出）', () => {
  it('ready 的 PR、ci 通过：到达终点；同一输出改为 draft 时未到达', () => {
    const recorded = recordedPr('grade-pr');
    const latest = latestPrFrom(recorded.stdout('list'));
    if (latest === null) throw new Error('没有 PR');
    const checks = checksFrom(recorded.repo, recorded.pr(), recorded.result('checks'));
    expect(prInfoFrom(latest, checks)).toEqual({
      number: 1,
      url: `https://github.com/${recorded.repo}/pull/1`,
      isDraft: false,
      head: 'c47fec0d5aec772afae43f4038748040489c3011',
      state: 'OPEN',
      checks: [{ name: 'ci', bucket: 'pass', state: 'SUCCESS' }],
    });
    const view = recorded.stdout('endpoint');
    const ready = {
      ciGreen: true,
      head: 'c47fec0d5aec772afae43f4038748040489c3011',
      missingRequired: [],
    };
    expect(endpointFrom(view, checks, ['ci'])).toEqual({
      ...ready,
      reached: true,
      isDraft: false,
    });
    const draft = JSON.stringify({ ...JSON.parse(view), isDraft: true });
    expect(endpointFrom(draft, checks, ['ci'])).toEqual({
      ...ready,
      reached: false,
      isDraft: true,
    });
    // 终点只看 task 的 requiredChecks
    expect(endpointFrom(view, checks, ['ci', 'e2e'])).toMatchObject({
      reached: false,
      ciGreen: false,
      missingRequired: ['e2e'],
    });
  });

  it('已关闭、没有任何 check 的 PR：checks 为空，终点为否，requiredChecks 为空时也不算', () => {
    const recorded = recordedPr('closed-no-checks');
    const latest = latestPrFrom(recorded.stdout('list'));
    // 两个 PR 中取最新建的
    expect(latest?.number).toBe(2);
    expect(recorded.result('checks').stderr).toContain('no checks reported');
    const checks = checksFrom(recorded.repo, recorded.pr(), recorded.result('checks'));
    expect(checks).toEqual([]);
    const view = recorded.stdout('endpoint');
    expect(endpointFrom(view, checks, ['ci'])).toMatchObject({
      reached: false,
      ciGreen: false,
      missingRequired: ['ci'],
    });
    expect(endpointFrom(view, checks, [])).toMatchObject({ reached: false, ciGreen: true });
    // 其他退出码 1 的错误照原文抛出
    expect(() =>
      checksFrom(recorded.repo, 2, { exitCode: 1, stdout: '', stderr: 'HTTP 502' }),
    ).toThrow(`gh pr checks ${recorded.repo}#2 退出码 1：HTTP 502`);
  });

  it('没有 PR 的仓库：录下的列表为空，现读同一个真实仓库也为 null', async () => {
    const recorded = recordedPr('no-pr');
    expect(latestPrFrom(recorded.stdout('list'))).toBeNull();
    expect(await readPr(recorded.repo)).toBeNull();
  });
});
