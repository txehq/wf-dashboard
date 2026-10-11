import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../../src/api/app.js';
import { config } from '../../src/config.js';
import { openDatabase } from '../../src/db/index.js';
import { bundleHead } from '../../src/external/github.js';
import { callLinear, closeLinearClient } from '../../src/external/linear.js';
import { ImportPreview, issueIdentifier } from '../../src/tasks/import-schema.js';
import { previewLinearImport, readLinearIssue } from '../../src/tasks/linear-import.js';
import { parseTaskYaml, serializeTask } from '../../src/tasks/loader.js';
import { IcTaskDefinition, TaskRecord } from '../../src/tasks/schema.js';
import { testRunId } from '../helpers/ic-fixture.js';

afterAll(closeLinearClient);

// 真实 Linear 与 GitHub，只读取：原工单与源仓库都不改动
describe('从 Linear 导入 ic task', { timeout: 5 * 60_000 }, () => {
  it('工单地址与编号都能取出编号；其他输入为 null', () => {
    expect(
      issueIdentifier(
        'https://linear.app/capso/issue/TXE-3546/cc-s01a11b-epic-okr-v0-follow-ups-feature-completeness-then',
      ),
    ).toBe('TXE-3546');
    expect(issueIdentifier(' TXE-3546 ')).toBe('TXE-3546');
    expect(issueIdentifier('https://github.com/txehq/txe/issues/3546')).toBeNull();
    expect(issueIdentifier('txe-3546')).toBeNull();
  });

  it('TXE-3546：粘贴地址导入，ticket.body 与 get_issue 的 description 逐字节相同，写成 task.yaml 读回仍相同', async () => {
    const preview = await previewLinearImport({
      issue:
        'https://linear.app/capso/issue/TXE-3546/cc-s01a11b-epic-okr-v0-follow-ups-feature-completeness-then',
      repo: 'txehq/take-home-question',
    });
    const raw = await callLinear(
      'get_issue',
      { id: 'TXE-3546', fields: ['description'] },
      z.object({ description: z.string() }),
    );
    expect(preview.task.ticket.body).toBe(raw.description);
    expect(preview.issue.description).toBe(raw.description);
    expect(raw.description.length).toBeGreaterThan(1000);
    expect(preview.task.source).toEqual({
      linear: { identifier: 'TXE-3546', url: preview.issue.url },
      github: { repo: 'txehq/take-home-question' },
    });
    expect(preview.commitSource).toEqual({ kind: 'default-branch', branch: 'master' });
    // 补上验收标准后是合法的 task；YAML 写出再读回，正文逐字节相同
    const criteria =
      preview.task.ticket.acceptanceCriteria.length > 0
        ? preview.task.ticket.acceptanceCriteria
        : ['正文中的全部要求都实现'];
    const definition = IcTaskDefinition.parse({
      ...preview.task,
      ticket: { ...preview.task.ticket, acceptanceCriteria: criteria },
    });
    const back = parseTaskYaml(serializeTask(definition), 'TXE-3546.yaml');
    expect(back.kind === 'ic' && back.ticket.body).toBe(raw.description);
    console.log(
      `TXE-3546 正文 ${String(raw.description.length)} 字符，验收标准 ${String(preview.task.ticket.acceptanceCriteria.length)} 条`,
    );
  });

  it('TXE-2107：## Acceptance criteria 一节的 10 条验收标准', async () => {
    const issue = await readLinearIssue('TXE-2107');
    expect(issue.status).toBe('Done');
    expect(issue.acceptanceCriteria).toHaveLength(10);
    expect(issue.acceptanceCriteria[0]).toBe(
      '`wf mcp unskip` puts the component back into the `applied` list of the next `wf repair` — verify: integration test',
    );
    expect(issue.acceptanceCriteria[9]).toContain("`wf-guard`'s `WF_SUBCOMMANDS`");
  });

  it('TXE-3635：默认仓库与 commit 取关联的已合并 PR 的 base commit；自托管 runner 的 job 不进 requiredChecks', async () => {
    const preview = await previewLinearImport({ issue: 'TXE-3635' });
    expect(preview.repo).toBe('txehq/tokun-cn');
    expect(preview.commit).toBe('f8df1eae355960da774e3e08f4f6a248f05b0910');
    expect(preview.commitSource).toMatchObject({
      kind: 'merged-pr',
      pr: { number: 638, state: 'MERGED', baseCommit: 'f8df1eae355960da774e3e08f4f6a248f05b0910' },
    });
    expect(preview.task.id).toBe('ic-txe-3635');
    expect(preview.task.requiredChecks).toEqual([]);
    expect(preview.workflows.jobs.length).toBeGreaterThan(20);
    expect(preview.workflows.jobs.every((j) => j.runsOn === null || j.runsOn === 'arc-linux-dind')).toBe(
      true,
    );
    expect(preview.workflows.jobs.some((j) => j.status === 'self-hosted')).toBe(true);
  });

  it('地址不是 Linear 工单、或工单不存在时以原文报错', async () => {
    await expect(
      previewLinearImport({ issue: 'https://linear.app/capso/project/okr' }),
    ).rejects.toThrow('不是 Linear 工单地址或工单编号：https://linear.app/capso/project/okr');
    await expect(previewLinearImport({ issue: 'TXE-999999' })).rejects.toThrow(
      /Linear get_issue 失败：.+/,
    );
  });

  it('API：POST /api/tasks/from-linear 只预览；POST /api/tasks 保存时在所选 commit 生成 bundle', async () => {
    const workDir = path.join(config.repoRoot, '.work/test-tasks', testRunId('w28-api'));
    const tasksDir = path.join(workDir, 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    const db = openDatabase(path.join(workDir, 'db.sqlite'), config.migrationsDir);
    const app = await buildApp({ db, sseHeartbeatMs: config.sseHeartbeatMs, logger: false, tasksDir });
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
      payload: { issue: 'TXE-3546', repo: 'txehq/take-home-question' },
    });
    expect(previewed.statusCode).toBe(200);
    const preview = ImportPreview.parse(previewed.json());
    // 预览不写文件
    expect(fs.readdirSync(tasksDir)).toEqual([]);
    const task = {
      ...preview.task,
      ticket: { ...preview.task.ticket, acceptanceCriteria: ['正文中的全部要求都实现'] },
    };
    const saved = await app.inject({ method: 'POST', url: '/api/tasks', payload: task });
    expect(saved.statusCode).toBe(201);
    expect(await bundleHead(path.join(tasksDir, task.id, 'repo.bundle'))).toBe(preview.commit);
    const record = TaskRecord.parse(saved.json());
    expect(record.task.kind === 'ic' && record.task.ticket.body).toBe(preview.issue.description);
    await app.close();
    db.$client.close();
  });
});
