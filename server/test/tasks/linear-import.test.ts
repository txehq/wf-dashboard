import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../../src/api/app.js';
import { config } from '../../src/config.js';
import { openDatabase } from '../../src/db/index.js';
import { bundleHead, readCommit } from '../../src/external/github.js';
import { callLinear, closeLinearClient } from '../../src/external/linear.js';
import { DEFAULT_COPY_RUNNER_LABELS } from '../../src/runs/settings.js';
import { ImportPreview, issueIdentifier } from '../../src/tasks/import-schema.js';
import { previewLinearImport, readLinearIssue } from '../../src/tasks/linear-import.js';
import { parseTaskYaml, serializeTask } from '../../src/tasks/loader.js';
import { TaskDefinition, TaskRecord } from '../../src/tasks/schema.js';
import { CALC_TICKET, CALC_TICKET_URL } from '../helpers/calc-repo.js';
import { testRunId } from '../helpers/ic-fixture.js';
import { IMPORT_SOURCE, NO_WORKFLOW_SOURCE } from '../helpers/import-source.js';

afterAll(closeLinearClient);

// 源仓库是已存在的 txehq/txe-workflow（只读取）
const { repo } = IMPORT_SOURCE;
// 9f2bed6 的 ci.yml 中由 pull_request 触发的 job（matrix 展开为 check 名），runner 为 arc-linux-dind 或 macos-15
const REQUIRED_AT_COMMIT = [
  'guard',
  'test (arc-linux-dind, x86_64-unknown-linux-gnu)',
  'test (macos-15, aarch64-apple-darwin)',
  'reproducible (arc-linux-dind)',
  'reproducible (macos-15)',
  'cross-platform-digest',
  'fresh-install (arc-linux-dind)',
  'fresh-install (macos-15)',
  'budgets',
  'upgrade-from-latest-release',
  'generated-surfaces',
  'supply-chain',
];

// 真实 Linear 与 GitHub：原工单与源仓库只读取
describe('从 Linear 导入 ic task', { timeout: 5 * 60_000 }, () => {
  it('工单地址与编号都能取出编号；其他输入为 null', () => {
    expect(issueIdentifier(CALC_TICKET_URL)).toBe(CALC_TICKET);
    expect(issueIdentifier(` ${CALC_TICKET} `)).toBe(CALC_TICKET);
    expect(issueIdentifier('https://github.com/txehq/txe/issues/3777')).toBeNull();
    expect(issueIdentifier('txe-3777')).toBeNull();
  });

  it('TXE-3777：粘贴地址导入，ticket.body 与 get_issue 的 description 逐字节相同，写成 task.yaml 读回仍相同', async () => {
    const preview = await previewLinearImport(
      { issue: CALC_TICKET_URL, repo },
      DEFAULT_COPY_RUNNER_LABELS,
    );
    const raw = await callLinear(
      'get_issue',
      { id: CALC_TICKET, fields: ['description'] },
      z.object({ description: z.string() }),
    );
    expect(preview.task.ticket.body).toBe(raw.description);
    expect(preview.issue.description).toBe(raw.description);
    expect(preview.task.source).toEqual({
      linear: { identifier: CALC_TICKET, url: preview.issue.url },
      // TXE-3777 没有关联 PR
      github: { repo, prs: [] },
    });
    // 工单没有关联 PR：默认 commit 为默认分支的最新 commit
    expect(preview.issue.linkedPrs).toEqual([]);
    expect(preview.commit).toBe((await readCommit(repo, 'main')).sha);
    expect(preview.commitSource).toEqual({ kind: 'default-branch', branch: 'main' });
    // 正文有 ## Acceptance criteria 一节，8 条；每个 quote 都是正文原文
    const drafted = preview.criteria;
    if (drafted === null) throw new Error('预览没有确定验收标准');
    expect(drafted.criteria).toHaveLength(8);
    expect(preview.task.ticket.acceptanceCriteria).toEqual(drafted.criteria.map((c) => c.text));
    for (const c of drafted.criteria) expect(raw.description).toContain(c.quote);
    const definition = TaskDefinition.parse(preview.task);
    const back = parseTaskYaml(serializeTask(definition), 'TXE-3777.yaml');
    expect(back.bigStage).toBe('ic');
    expect(back.ticket?.body).toBe(raw.description);
    console.log(
      `TXE-3777 正文 ${String(raw.description.length)} 字符，验收标准 ${String(drafted.criteria.length)} 条，${drafted.model}，花费 $${drafted.costUsd.toFixed(4)}`,
    );
  });

  it('requiredChecks 默认值：txe-workflow 9f2bed6 的 ci 中能在副本 PR 上运行的 job，release 不由 pull_request 触发', async () => {
    const at = { issue: CALC_TICKET, repo, commit: IMPORT_SOURCE.commit, criteria: false };
    const preview = await previewLinearImport(at, DEFAULT_COPY_RUNNER_LABELS);
    expect(preview.criteria).toBeNull();
    expect(preview.commitSource).toEqual({ kind: 'given' });
    expect(preview.task.requiredChecks).toEqual(REQUIRED_AT_COMMIT);
    // release.yml 由 push 与 workflow_dispatch 触发：全部 job 不计入终点
    expect(
      preview.workflows.jobs.map((j) => [j.checkName, j.runsOn, j.status, j.onPush]),
    ).toEqual([
      ...REQUIRED_AT_COMMIT.map((name) => [
        name,
        name.includes('macos-15') ? 'macos-15' : 'arc-linux-dind',
        'required',
        false,
      ]),
      ['gate', 'arc-linux-dind', 'not-on-pr', false],
      ['build (macos-15, aarch64-apple-darwin)', 'macos-15', 'not-on-pr', false],
      ['build (arc-linux-dind, x86_64-unknown-linux-gnu)', 'arc-linux-dind', 'not-on-pr', false],
      ['compile', 'arc-linux-dind', 'not-on-pr', false],
      ['publish', 'arc-linux-dind', 'not-on-pr', false],
      ['promote', 'arc-linux-dind', 'not-on-pr', false],
    ]);
    // copyRunnerLabels 中没有 arc-linux-dind 时，它不在副本可用的 runner 范围内，只剩 macos-15 的 job
    const without = await previewLinearImport(at, []);
    expect(without.task.requiredChecks).toEqual(
      REQUIRED_AT_COMMIT.filter((name) => name.includes('macos-15')),
    );
    expect(without.workflows.jobs.find((j) => j.checkName === 'guard')?.status).toBe(
      'runner-unavailable',
    );
    // 没有 .github/workflows 的仓库：requiredChecks 为空
    const none = await previewLinearImport(
      { issue: CALC_TICKET, ...NO_WORKFLOW_SOURCE, criteria: false },
      DEFAULT_COPY_RUNNER_LABELS,
    );
    expect(none.workflows).toEqual({ jobs: [], requiredChecks: [] });
  });

  it('工单本身没有关联 PR 时必须指定仓库', async () => {
    const issue = await readLinearIssue(CALC_TICKET);
    expect(issue.linkedPrs).toEqual([]);
    await expect(
      previewLinearImport({ issue: CALC_TICKET, criteria: false }, DEFAULT_COPY_RUNNER_LABELS),
    ).rejects.toThrow(`工单 ${CALC_TICKET} 没有关联已合并的 GitHub PR，需要指定仓库`);
  });

  it('地址不是 Linear 工单、或工单不存在时以原文报错', async () => {
    await expect(
      previewLinearImport(
        { issue: 'https://linear.app/capso/project/okr' },
        DEFAULT_COPY_RUNNER_LABELS,
      ),
    ).rejects.toThrow('不是 Linear 工单地址或工单编号：https://linear.app/capso/project/okr');
    await expect(
      previewLinearImport({ issue: 'TXE-999999' }, DEFAULT_COPY_RUNNER_LABELS),
    ).rejects.toThrow(/Linear get_issue 失败：.+/);
  });

  it('API：POST /api/tasks/from-linear 只预览；POST /api/tasks 保存时在所选 commit 生成 bundle', async () => {
    const workDir = path.join(config.repoRoot, '.work/test-tasks', testRunId('w28-api'));
    const tasksDir = path.join(workDir, 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    const db = openDatabase(path.join(workDir, 'db.sqlite'), config.migrationsDir);
    const app = await buildApp({
      db,
      sseHeartbeatMs: config.sseHeartbeatMs,
      logger: false,
      tasksDir,
    });
    const bad = await app.inject({
      method: 'POST',
      url: '/api/tasks/from-linear',
      payload: { issue: 'https://example.com/TXE-1' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('不是 Linear 工单地址或工单编号：https://example.com/TXE-1');

    const previewed = await app.inject({
      method: 'POST',
      url: '/api/tasks/from-linear',
      payload: { issue: CALC_TICKET, repo, commit: IMPORT_SOURCE.commit, criteria: false },
    });
    expect(previewed.statusCode).toBe(200);
    const preview = ImportPreview.parse(previewed.json());
    // 设置的默认 copyRunnerLabels 生效
    expect(preview.task.requiredChecks).toEqual(REQUIRED_AT_COMMIT);
    // 预览不写文件
    expect(fs.readdirSync(tasksDir)).toEqual([]);
    const task = {
      ...preview.task,
      ticket: { ...preview.task.ticket, acceptanceCriteria: ['页面外壳与 CI 按工单建立'] },
    };
    const saved = await app.inject({ method: 'POST', url: '/api/tasks', payload: task });
    expect(saved.statusCode).toBe(201);
    expect(await bundleHead(path.join(tasksDir, task.id, 'repo.bundle'))).toBe(preview.commit);
    // 临时克隆目录已删除，task 目录中只有 bundle 与 task.yaml
    expect(fs.readdirSync(path.join(tasksDir, task.id)).sort()).toEqual([
      'repo.bundle',
      'task.yaml',
    ]);
    const record = TaskRecord.parse(saved.json());
    expect(record.task.bigStage).toBe('ic');
    expect(record.task.ticket?.body).toBe(preview.issue.description);
    await app.close();
    db.$client.close();
  });
});
