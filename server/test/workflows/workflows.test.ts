import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { buildApp } from '../../src/api/app.js';
import { config } from '../../src/config.js';
import { syncTasks } from '../../src/tasks/loader.js';
import { createVariants } from '../../src/variants/index.js';
import { EVAL_KINDS, evalSpec, taskFieldsOfKind } from '../../src/workflows/eval-kinds.js';
import { builtinDefinition, loadWorkflow } from '../../src/workflows/index.js';
import { EvalKindConfig, WorkflowDefinition, WorkflowView } from '../../src/workflows/schema.js';
import { openTestDb } from '../stages/db.js';

// Contracts 16.1、16.2：workflow 定义的校验、两种评测类型的内部配置、API、从 variant 复制成新 workflow，
// 以及构建时的 skill 检查
const myreviewYaml = parse(
  fs.readFileSync(path.join(import.meta.dirname, '../fixtures/workflows/myreview.yaml'), 'utf8'),
) as Record<string, unknown>;

// 失败时的原文：zod 把 superRefine 的 message 放进 error.message
function issuesOf(schema: typeof WorkflowDefinition | typeof EvalKindConfig, value: unknown) {
  const result = schema.safeParse(value);
  if (result.success) throw new Error('应当校验失败');
  return result.error.message;
}

type Stages = Record<string, unknown>[];
const myreview = () => structuredClone(myreviewYaml) as { stages: Stages; [k: string]: unknown };

describe('workflow 定义的校验', () => {
  test('16.1 的 myreview 例子通过', () => {
    expect(WorkflowDefinition.parse(myreviewYaml)).toEqual({
      id: 'myreview',
      name: '我的 review 流程',
      stages: [
        { id: 'scan' },
        { id: 'fix', repeatable: true, allowInside: ['scan'] },
        { id: 'report' },
      ],
    });
  });

  test('内置的 lfg 与 ic：小阶段、fix-pr 的 repeatable 与 allowInside', () => {
    expect(builtinDefinition('lfg')).toEqual({
      id: 'lfg',
      name: 'lfg',
      stages: [{ id: 'interview' }, { id: 'research' }, { id: 'plan' }, { id: 'ticketing' }],
    });
    const ic = builtinDefinition('ic');
    expect(ic.stages.map((s) => s.id)).toEqual([
      'claim',
      'readiness',
      'implement',
      'acceptance',
      'open-pr',
      'fix-pr',
      'ready-for-review',
    ]);
    expect(ic.stages.find((s) => s.id === 'fix-pr')).toEqual({
      id: 'fix-pr',
      repeatable: true,
      allowInside: ['acceptance'],
    });
  });

  test('小阶段 id 重复、与 workflow 同名、allowInside 引用不存在的小阶段、id 不是 slug，各以原文失败', () => {
    const duplicate = myreview();
    duplicate.stages.push({ id: 'scan' });
    expect(issuesOf(WorkflowDefinition, duplicate)).toContain('小阶段 id 重复：scan');
    const entry = myreview();
    entry.stages.push({ id: 'myreview' });
    expect(issuesOf(WorkflowDefinition, entry)).toContain('小阶段 myreview 与 workflow 同名');
    const inside = myreview();
    inside.stages[1] = { id: 'fix', allowInside: ['scan', 'deploy'] };
    expect(issuesOf(WorkflowDefinition, inside)).toContain(
      '小阶段 fix 的 allowInside 引用了不存在的小阶段 deploy',
    );
    expect(issuesOf(WorkflowDefinition, { ...myreview(), id: 'My Review' })).toContain(
      '只能包含小写字母、数字与连字符，以字母开头',
    );
  });
});

describe('评测类型的内部配置（16.2）', () => {
  test('lfg 与 ic：积木、dispatch gate、评分与推出的 task 字段', () => {
    expect(EVAL_KINDS.lfg).toMatchObject({
      prepare: ['empty-repo', 'vault-dir'],
      dispatchGate: true,
    });
    expect(EVAL_KINDS.ic).toMatchObject({
      prepare: ['repo-copy', 'ticket-copy'],
      grading: ['hidden-tests', 'criteria-judge', 'pr-endpoint'],
    });
    expect(EVAL_KINDS.ic.dispatchGate).toBeUndefined();
    expect(taskFieldsOfKind('lfg')).toEqual(['input', 'persona', 'hiddenRequirements', 'rubric']);
    expect(taskFieldsOfKind('ic')).toEqual([
      'persona',
      'hiddenRequirements',
      'ticket',
      'repo',
      'requiredChecks',
      'hiddenTests',
    ]);
    // 入口命令取 workflow 的 id
    expect(evalSpec('lfg', 'mylfg')).toMatchObject({ id: 'mylfg', kind: 'lfg' });
  });

  test('message 的占位与评分积木的依赖不满足时以原文失败', () => {
    expect(
      issuesOf(EvalKindConfig, { ...EVAL_KINDS.lfg, message: '{entry} {input} {ticket}' }),
    ).toContain(
      '评测类型 lfg：message 用了积木没有提供的占位 {ticket}（可用：{entry}、{input}、{runId}、{repo}）',
    );
    const text = issuesOf(EvalKindConfig, { ...EVAL_KINDS.ic, prepare: ['ticket-copy'] });
    expect(text).toContain('评分 hidden-tests 要求准备积木 repo-copy');
    expect(text).toContain('评分 pr-endpoint 要求准备积木 repo-copy');
    expect(issuesOf(EvalKindConfig, { ...EVAL_KINDS.ic, prepare: ['repo-copy'] })).toContain(
      '评分 criteria-judge 要求准备积木 ticket-copy',
    );
    expect(issuesOf(EvalKindConfig, { ...EVAL_KINDS.lfg, prepare: ['empty-repo'] })).toContain(
      '评分 rubric 要求准备积木 vault-dir',
    );
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
const created: string[] = [];
beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  for (const id of created) fs.rmSync(variants.layout(id).dir, { recursive: true, force: true });
  await app.close();
  close();
});

describe('workflows API 与从空白新建', () => {
  test('GET 列出内置的 lfg、ic 与 session-analysis 与 yaml 中的描述；内置的只能改描述，改定义 409', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/workflows' });
    expect(list.statusCode).toBe(200);
    const views = WorkflowView.array().parse(list.json());
    expect(views.map((w) => [w.id, w.evalKind, w.builtin, w.wf])).toEqual([
      ['lfg', 'lfg', true, true],
      ['ic', 'ic', true, true],
      ['session-analysis', null, true, false],
    ]);
    expect(views[0]?.description).toBe(
      '从一个新想法到 Linear 工单：访谈确定边界，本地与网上调研，计划，拆成工单后停在 dispatch gate。',
    );
    const put = (payload: Record<string, unknown>) =>
      app.inject({ method: 'PUT', url: '/api/workflows/lfg', payload });
    const changed = await put({
      name: 'lfg',
      description: '',
      definition: { ...builtinDefinition('lfg'), stages: [{ id: 'interview' }] },
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json<{ message: string }>().message).toBe(
      'lfg 是内置的 workflow，只能修改描述；要换入口或小阶段就从空白新建一个 workflow',
    );
    const described = await put({
      name: 'lfg',
      description: '  只改描述  ',
      definition: builtinDefinition('lfg'),
    });
    expect(described.statusCode).toBe(200);
    expect(WorkflowView.parse(described.json()).description).toBe('只改描述');
  });

  test('从空白新建 myreview：没有评测类型，第一个 variant"初稿"是入口与各小阶段的 SKILL.md 骨架', async () => {
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/workflows', payload });
    const response = await post({
      id: 'myreview',
      name: '我的 review 流程',
      description: '扫描、修复、报告',
      definition: myreviewYaml,
    });
    expect(response.statusCode).toBe(201);
    const view = WorkflowView.parse(response.json());
    expect([view.evalKind, view.builtin, view.variants, view.description]).toEqual([
      null,
      false,
      1,
      '扫描、修复、报告',
    ]);
    const first = variants.list().find((v) => v.workflowId === 'myreview');
    if (first === undefined) throw new Error('myreview 没有 variant');
    created.push(first.id);
    expect([first.name, first.parentId, first.baseCommit, first.status]).toEqual([
      '初稿',
      null,
      '',
      'draft',
    ]);
    expect(first.version).toBe(`skills.${first.skillsHash.slice(0, 8)}`);
    expect(variants.listFiles(first.id).map((f) => f.path)).toEqual([
      'skills/fix/SKILL.md',
      'skills/myreview/SKILL.md',
      'skills/report/SKILL.md',
      'skills/scan/SKILL.md',
    ]);
    expect(variants.readFile(first.id, 'skills/scan/SKILL.md')).toBe(
      '---\nname: scan\ndescription: 我的 review 流程 的小阶段 scan\n---\n\n在这里写这个阶段做什么。\n',
    );
    expect(variants.readFile(first.id, 'skills/myreview/SKILL.md')).toContain(
      'description: 我的 review 流程 的入口 /myreview：依次进入 scan、fix、report',
    );
    expect(loadWorkflow(db, 'myreview').stages.map((s) => s.id)).toEqual(['scan', 'fix', 'report']);

    // id 已存在 409；与其他 workflow 的小阶段同名 400；定义与请求不一致 400
    expect(
      (
        await post({
          id: 'myreview',
          name: '我的 review 流程',
          description: '',
          definition: myreviewYaml,
        })
      ).statusCode,
    ).toBe(409);
    const clash = await post({
      id: 'interview',
      name: 'interview',
      description: '',
      definition: { ...myreviewYaml, id: 'interview', name: 'interview' },
    });
    expect(clash.statusCode).toBe(400);
    expect(clash.json<{ message: string }>().message).toBe(
      'workflow id interview 与 workflow lfg 的小阶段同名',
    );
    const mismatch = await post({
      id: 'other',
      name: 'other',
      description: '',
      definition: myreviewYaml,
    });
    expect(mismatch.statusCode).toBe(400);

    // 改名、描述与小阶段；评测类型不变
    const renamed = await app.inject({
      method: 'PUT',
      url: '/api/workflows/myreview',
      payload: {
        name: '审阅流程',
        description: '只剩扫描',
        definition: { ...myreviewYaml, name: '审阅流程', stages: [{ id: 'scan' }] },
      },
    });
    expect(renamed.statusCode).toBe(200);
    expect(WorkflowView.parse(renamed.json())).toMatchObject({
      name: '审阅流程',
      description: '只剩扫描',
      evalKind: null,
      definition: { stages: [{ id: 'scan' }] },
    });

    // 任意 workflow 不导入 txe-workflow 的基线；派生只在同一 workflow 内
    const baseline = await app.inject({
      method: 'POST',
      url: '/api/variants',
      payload: { name: '基线', workflowId: 'myreview' },
    });
    expect(baseline.statusCode).toBe(400);
    expect(baseline.json<{ message: string }>().message).toBe(
      'workflow myreview 不是内置的 lfg 或 ic，不能导入 txe-workflow 的基线；从它已有的 variant 派生',
    );
    const cross = await app.inject({
      method: 'POST',
      url: `/api/variants/${first.id}/derive`,
      payload: { name: '跨 workflow', workflowId: 'lfg' },
    });
    expect(cross.statusCode).toBe(400);
    expect(cross.json<{ message: string }>().message).toContain('派生只能在同一 workflow 内');
  });
});
