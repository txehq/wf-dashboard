import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  callLinear,
  closeLinearClient,
  createRunTicket,
  ensureEvalContainer,
  findOrCreateEvalContainer,
  linearLoggedIn,
  readTicket,
} from '../src/external/linear.js';
import { buildFixtureTask, testRunId } from './helpers/ic-fixture.js';

afterAll(async () => {
  await closeLinearClient();
});

describe('Linear MCP', () => {
  it('本机已登录 Linear', () => {
    expect(linearLoggedIn()).toBe(true);
  });

  it('ensureEvalContainer 幂等：复用 P-TXE-17 与 eval label', async () => {
    const first = await findOrCreateEvalContainer();
    const second = await findOrCreateEvalContainer();
    expect(second).toEqual(first);
    expect(first.projectId).toBe('P-TXE-17');
    expect(first.projectUuid).toBe('a282c47c-dcb6-4f62-8336-471917a4bb22');
    expect(first.labelId).toBe('b3d3a38a-5719-4de3-9496-252b5ec190bc');
    expect(first.statuses.map((s) => s.name)).toEqual(
      expect.arrayContaining(['Todo', 'In Progress', 'In Review', 'Done']),
    );
    expect(await ensureEvalContainer()).toEqual(first);
    expect(await ensureEvalContainer()).toBe(await ensureEvalContainer());
  }, 120_000);

  it('createRunTicket 建出工单，readTicket 读回状态、状态历史与评论', async () => {
    const runId = testRunId('w7');
    const task = await buildFixtureTask(runId);
    const ticket = await createRunTicket(task, runId);
    console.log(`Linear 工单 ${ticket.identifier} ${ticket.url}`);
    expect(ticket.identifier).toMatch(/^TXE-\d+$/);
    expect(ticket.url).toContain(`/issue/${ticket.identifier}/`);

    const fresh = await readTicket(ticket.identifier);
    expect(fresh).toMatchObject({
      identifier: ticket.identifier,
      status: 'Todo',
      statusType: 'unstarted',
      url: ticket.url,
      comments: [],
    });
    expect(fresh.stateHistory).toHaveLength(1);
    expect(fresh.stateHistory[0]).toMatchObject({ state: 'Todo', endedAt: null });

    const issue = await callLinear(
      'get_issue',
      { id: ticket.identifier, fields: ['id', 'title', 'description', 'labels', 'project'] },
      z.object({
        title: z.string(),
        description: z.string(),
        labels: z.array(z.string()),
        project: z.string(),
      }),
    );
    expect(issue.title).toBe(`[eval] w7-fixture ${runId} 给 math 模块增加 subtract`);
    expect(issue.labels).toEqual(['eval']);
    expect(issue.project).toBe('Workflow Eval');
    expect(issue.description).toContain('## Acceptance criteria');
    expect(issue.description).toContain('AC1 `subtract(5, 3)` 返回 `2`');
    expect(issue.description.trim().endsWith(`run id: \`${runId}\``)).toBe(true);

    // 模拟 /ic 的认领：评论与状态变化都应读回
    await callLinear(
      'save_comment',
      { issueId: ticket.identifier, body: `W7 集成测试评论 · run id ${runId}` },
      z.object({ id: z.string() }).loose(),
    );
    await callLinear(
      'save_issue',
      { id: ticket.identifier, state: 'In Progress' },
      z.object({ id: z.string() }).loose(),
    );
    const claimed = await readTicket(ticket.identifier);
    expect(claimed.status).toBe('In Progress');
    expect(claimed.statusType).toBe('started');
    expect(claimed.stateHistory.map((h) => h.state)).toEqual(['Todo', 'In Progress']);
    expect(claimed.stateHistory[0]?.endedAt).not.toBeNull();
    expect(claimed.comments).toHaveLength(1);
    expect(claimed.comments[0]).toMatchObject({
      body: `W7 集成测试评论 · run id ${runId}`,
      author: 'lin luo',
    });
  }, 180_000);
});
