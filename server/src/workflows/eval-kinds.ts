import {
  type EvalKind,
  EvalKindConfig,
  type EvalSpec,
  type TaskFieldName,
  taskFieldsOf,
} from './schema.js';

// 两种评测类型的内部配置（Contracts 16.2）：与 7.2、7.4、7.9、第 13 节的行为相同，用户不编辑。
// 有评测类型的 workflow 运行时按它的评测类型取用；初始消息中的 {entry} 为 /<workflow id>
export const EVAL_KINDS: Record<EvalKind, EvalKindConfig> = {
  lfg: EvalKindConfig.parse({
    kind: 'lfg',
    prepare: ['empty-repo', 'vault-dir'],
    message: '{entry} {input}\n\nProduct: Magi Eval\nFeature slug: {runId}\nRepository: {repo}',
    done: '你在之前的对话中已经回答过 dispatch gate（不派发），并且 agent 最新一轮报告了结束状态；或 agent 明确报告无法继续。',
    dispatchGate: true,
    grading: [
      {
        rubric: {
          artifacts: [
            {
              id: 'brief',
              files: [{ file: 'Brief.md', kind: 'brief' }],
              description: 'Brief.md：interview 阶段写出的需求简报',
            },
            {
              id: 'research',
              files: [
                { file: 'Research.md', kind: 'research' },
                { file: 'System Design.md', kind: 'design' },
              ],
              description: 'Research.md：基于 brief 的调研与 spec',
            },
            {
              id: 'plan',
              files: [
                { file: 'Research.md', kind: 'research' },
                { file: 'System Design.md', kind: 'design' },
              ],
              description: '锁定后的 plan（Research.md 的 Plan 一节或 System Design.md）',
              lockedPlan: true,
            },
            {
              id: 'tickets',
              files: [{ file: 'Tickets.md', kind: 'tickets' }],
              description: 'Tickets.md 与该 run 在 Linear 中建出的工单',
              linearTickets: true,
            },
          ],
        },
      },
    ],
  }),
  ic: EvalKindConfig.parse({
    kind: 'ic',
    prepare: ['repo-copy', 'ticket-copy'],
    message: '{entry} {ticket}',
    done: 'agent 最新一轮报告 PR 已经标记为 ready for review（工单已移到 review 状态）；或 agent 明确报告无法继续。',
    grading: ['hidden-tests', 'criteria-judge', 'pr-endpoint'],
  }),
};

// workflow 运行时取用的配置：入口命令为 /<workflowId>
export const evalSpec = (kind: EvalKind, workflowId: string): EvalSpec => ({
  ...EVAL_KINDS[kind],
  id: workflowId,
});

// 评测类型决定的 task 字段（16.3）
export const taskFieldsOfKind = (kind: EvalKind): TaskFieldName[] => taskFieldsOf(EVAL_KINDS[kind]);

// 初始消息中 {entry} 的值
export const entryOf = (workflowId: string) => `/${workflowId}`;
