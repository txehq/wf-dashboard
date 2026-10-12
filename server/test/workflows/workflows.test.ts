import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { buildApp } from '../../src/api/app.js';
import { config } from '../../src/config.js';
import { syncTasks } from '../../src/tasks/loader.js';
import { createVariants } from '../../src/variants/index.js';
import { builtinDefinition, loadWorkflow } from '../../src/workflows/index.js';
import { taskFieldsOf, WorkflowDefinition, WorkflowView } from '../../src/workflows/schema.js';
import { openTestDb } from '../stages/db.js';

// Contracts 16.1、16.2：workflow 定义的校验、API、从 variant 复制成新 workflow，以及构建时的 skill 检查
const nextYaml = parse(
  fs.readFileSync(
    path.join(import.meta.dirname, '../fixtures/workflows/next-workflow.yaml'),
    'utf8',
  ),
) as Record<string, unknown>;

// 失败时的原文：zod 把 superRefine 的 message 放进 error.message
function issuesOf(value: unknown): string {
  const result = WorkflowDefinition.safeParse(value);
  if (result.success) throw new Error('定义应当校验失败');
  return result.error.message;
}

type BigStages = { id: string; stages: Record<string, unknown>[]; [k: string]: unknown }[];
const next = () => structuredClone(nextYaml) as { bigStages: BigStages; [k: string]: unknown };

describe('workflow 定义的校验', () => {
  test('16.1 的 next-workflow 例子通过；taskFields 与积木推出的一致', () => {
    const definition = WorkflowDefinition.parse(nextYaml);
    expect(definition.bigStages.map((s) => [s.id, s.stages.map((x) => x.id)])).toEqual([
      ['newlfg', ['scope', 'spike', 'tickets']],
      ['newic', ['build', 'ship', 'polish']],
    ]);
    const [newlfg, newic] = definition.bigStages;
    if (newlfg === undefined || newic === undefined) throw new Error('缺少大阶段');
    expect(taskFieldsOf(newlfg)).toEqual(['input', 'persona', 'hiddenRequirements', 'rubric']);
    expect(taskFieldsOf(newic)).toEqual([
      'persona',
      'hiddenRequirements',
      'ticket',
      'repo',
      'requiredChecks',
      'hiddenTests',
    ]);
    // 简写的产物条目展开为 files
    expect(newlfg.grading).toEqual([
      {
        rubric: {
          artifacts: [
            { id: 'scope', files: [{ file: 'Scope.md', kind: 'scope' }], description: 'Scope.md' },
            {
              id: 'tickets',
              files: [{ file: 'Tickets.md', kind: 'tickets' }],
              description: 'Tickets.md',
            },
          ],
        },
      },
    ]);
  });

  test('内置的 dev-workflow：lfg 与 ic 的小阶段、fix-pr 的 repeatable 与 allowInside', () => {
    const dev = builtinDefinition();
    expect(dev.bigStages.map((s) => [s.id, s.stages.map((x) => x.id)])).toEqual([
      ['lfg', ['interview', 'research', 'plan', 'ticketing']],
      [
        'ic',
        ['claim', 'readiness', 'implement', 'acceptance', 'open-pr', 'fix-pr', 'ready-for-review'],
      ],
    ]);
    expect(dev.bigStages[1]?.stages.find((s) => s.id === 'fix-pr')).toEqual({
      id: 'fix-pr',
      repeatable: true,
      allowInside: ['acceptance'],
    });
    expect(dev.bigStages[0]?.dispatchGate).toBe(true);
    expect(dev.bigStages[1]?.dispatchGate).toBeUndefined();
  });

  test('大阶段 id 重复以原文失败', () => {
    const d = next();
    const [first] = d.bigStages;
    if (first === undefined) throw new Error('缺少大阶段');
    d.bigStages.push({ ...structuredClone(first) });
    expect(issuesOf(d)).toContain('大阶段 id 重复：newlfg');
  });

  test('allowInside 引用不存在的小阶段以原文失败', () => {
    const d = next();
    const polish = d.bigStages[1]?.stages.find((s) => s.id === 'polish');
    if (polish === undefined) throw new Error('缺少 polish');
    polish.allowInside = ['build', 'deploy'];
    expect(issuesOf(d)).toContain(
      '大阶段 newic：小阶段 polish 的 allowInside 引用了不存在的小阶段 deploy',
    );
  });

  test('message 用了积木没有提供的占位以原文失败', () => {
    const d = next();
    const newlfg = d.bigStages[0];
    if (newlfg === undefined) throw new Error('缺少 newlfg');
    newlfg.message = '/newlfg {input} {ticket}';
    expect(issuesOf(d)).toContain(
      '大阶段 newlfg：message 用了积木没有提供的占位 {ticket}（可用：{input}、{runId}、{repo}）',
    );
  });

  test('taskFields 与积木推出的不一致、评分积木缺少依赖时以原文失败', () => {
    const d = next();
    const newic = d.bigStages[1];
    if (newic === undefined) throw new Error('缺少 newic');
    newic.taskFields = ['persona', 'hiddenRequirements', 'ticket'];
    newic.prepare = ['ticket-copy'];
    newic.message = '/newic {ticket}';
    const text = issuesOf(d);
    expect(text).toContain('评分 hidden-tests 要求准备积木 repo-copy');
    expect(text).toContain('taskFields 为 persona, hiddenRequirements, ticket');
  });
});

const { db, close } = openTestDb();
syncTasks(db, config.tasksDir);
const app = await buildApp({
  db,
  sseHeartbeatMs: config.sseHeartbeatMs,
  logger: false,
  tasksDir: config.tasksDir,
});
const variants = createVariants({
  db,
  dataDir: config.dataDir,
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
});
beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  await app.close();
  close();
});

describe('workflows API 与从 variant 复制', () => {
  test('GET 列出内置的 dev-workflow；PUT dev-workflow 返回 409', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/workflows' });
    expect(list.statusCode).toBe(200);
    const [dev] = WorkflowView.array().parse(list.json());
    expect(dev?.id).toBe('dev-workflow');
    expect(dev?.builtin).toBe(true);
    expect(dev?.taskFields).toEqual({
      lfg: ['input', 'persona', 'hiddenRequirements', 'rubric'],
      ic: ['persona', 'hiddenRequirements', 'ticket', 'repo', 'requiredChecks', 'hiddenTests'],
    });
    const put = await app.inject({
      method: 'PUT',
      url: '/api/workflows/dev-workflow',
      payload: { definition: builtinDefinition() },
    });
    expect(put.statusCode).toBe(409);
    expect(put.json<{ message: string }>().message).toContain('dev-workflow 是内置的，不能修改');
  });

  test(
    '从基线复制成 next-workflow：底子为"基线"；构建时缺少阶段 skill 以原文失败；跨 workflow 派生被拒绝',
    { timeout: 300_000 },
    async () => {
      const base = await variants.createBaseline({ name: '基线' });
      expect(base.workflowId).toBe('dev-workflow');
      const created = await app.inject({
        method: 'POST',
        url: '/api/workflows',
        payload: {
          id: 'next-workflow',
          name: 'next-workflow',
          variantId: base.id,
          definition: nextYaml,
        },
      });
      expect(created.statusCode).toBe(201);
      const view = WorkflowView.parse(created.json());
      expect(view.builtin).toBe(false);
      if (view.baseVariantId === null) throw new Error('新 workflow 没有底子');
      const copy = variants.get(view.baseVariantId);
      // 同名的"基线"在不同 workflow 中可以共存
      expect([copy.name, copy.workflowId, copy.parentId, copy.skillsHash]).toEqual([
        '基线',
        'next-workflow',
        base.id,
        base.skillsHash,
      ]);
      expect(loadWorkflow(db, 'next-workflow').bigStages.map((s) => s.id)).toEqual([
        'newlfg',
        'newic',
      ]);

      // 基线的 skill 中没有 next-workflow 的入口与小阶段
      await expect(variants.build(copy.id)).rejects.toThrow(
        'variant 基线 缺少 workflow next-workflow 要求的 skill：newlfg、scope、spike、tickets、newic、build、ship、polish（应为 src/skills/<名字>/SKILL.md）',
      );
      expect(variants.get(copy.id).buildStatus).toBe('failed');

      const cross = await app.inject({
        method: 'POST',
        url: `/api/variants/${base.id}/derive`,
        payload: { name: '跨 workflow', workflowId: 'next-workflow' },
      });
      expect(cross.statusCode).toBe(400);
      expect(cross.json<{ message: string }>().message).toContain('派生只能在同一 workflow 内');

      // 复制 :id 的定义，换掉 id 与 name
      const copied = await app.inject({
        method: 'POST',
        url: '/api/workflows/next-workflow/copy',
        payload: { variantId: copy.id, id: 'next-2', name: 'next 2' },
      });
      expect(copied.statusCode).toBe(201);
      const second = WorkflowView.parse(copied.json());
      expect([second.id, second.name]).toEqual(['next-2', 'next 2']);
      expect(WorkflowDefinition.parse(second.definition).bigStages.map((s) => s.id)).toEqual([
        'newlfg',
        'newic',
      ]);
      for (const id of [copy.id, view.baseVariantId, second.baseVariantId, base.id]) {
        if (id !== null) fs.rmSync(variants.layout(id).dir, { recursive: true, force: true });
      }
    },
  );
});
