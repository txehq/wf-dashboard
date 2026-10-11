import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { callLinear, closeLinearClient, createRunTicket } from '../src/external/linear.js';
import { readIssueForImport } from '../src/external/linear.js';
import type { IcTask } from '../src/tasks/schema.js';
import { CALC_TICKET } from './helpers/calc-repo.js';
import { testRunId } from './helpers/ic-fixture.js';

afterAll(closeLinearClient);

// 真实建一张工单副本（Workflow Eval project）：从 Linear 导入的 task 的副本正文是 ticket.body 全文加 run id，
// 不出现来源工单编号、来源仓库与来源 PR（Contracts 第 13 节）
describe('从 Linear 导入的 task 的工单副本', () => {
  it('TXE-3777 的副本：正文为原文加 run id，标题与正文都不含来源编号与来源仓库', async () => {
    const source = await readIssueForImport(CALC_TICKET);
    const runId = testRunId('w29-copy');
    const sourceRepo = 'txehq/wfe-test-calc-source';
    const task: IcTask = {
      id: 'ic-txe-3777',
      kind: 'ic',
      dir: '/nonexistent',
      title: source.title,
      persona: 'p',
      hiddenRequirements: 'h',
      source: {
        linear: { identifier: CALC_TICKET, url: source.url },
        github: { repo: sourceRepo },
      },
      ticket: { title: source.title, body: source.description, acceptanceCriteria: ['a'] },
      repo: { path: 'repo.bundle', commit: 'a'.repeat(40) },
      requiredChecks: [],
    };
    const ticket = await createRunTicket(task, runId);
    console.log(`Linear 工单副本 ${ticket.identifier} ${ticket.url}`);
    const copy = await callLinear(
      'get_issue',
      { id: ticket.identifier, fields: ['title', 'description', 'project', 'labels'] },
      z.object({
        title: z.string(),
        description: z.string(),
        project: z.string(),
        labels: z.array(z.string()),
      }),
    );
    expect(copy.project).toBe('Workflow Eval');
    expect(copy.labels).toEqual(['eval']);
    expect(copy.title).toBe(`[eval] ${runId} ${source.title}`);
    // Linear 存回的 markdown 会规范化部分写法，逐行比较原文中的每个非空行都在副本中
    for (const line of source.description.split('\n').filter((l) => l.trim().startsWith('## '))) {
      expect(copy.description).toContain(line.trim());
    }
    expect(copy.description.trimEnd().endsWith(`run id: \`${runId}\``)).toBe(true);
    for (const text of [`source: ${CALC_TICKET}`, 'ic-txe-3777', sourceRepo]) {
      expect(copy.title).not.toContain(text);
      expect(copy.description).not.toContain(text);
    }
  }, 120_000);
});
