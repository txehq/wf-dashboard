import {
  type EvalKind,
  EvalKindConfig,
  type EvalSpec,
  type TaskFieldName,
  taskFieldsOf,
} from './schema.js';

// Internal configuration of the two eval kinds (Contracts 16.2): same behavior as 7.2, 7.4, 7.9 and section 13; not
// edited by users. A workflow with an eval kind uses it at run time; {entry} in the initial message is /<workflow id>
export const EVAL_KINDS: Record<EvalKind, EvalKindConfig> = {
  lfg: EvalKindConfig.parse({
    kind: 'lfg',
    prepare: ['empty-repo', 'vault-dir'],
    message: '{entry} {input}\n\nProduct: Magi Eval\nFeature slug: {runId}\nRepository: {repo}',
    done: 'Earlier in the conversation you already answered the dispatch gate (no dispatch), and the agent reported a final status in its latest turn; or the agent explicitly reported that it cannot continue.',
    dispatchGate: true,
    grading: [
      {
        rubric: {
          artifacts: [
            {
              id: 'brief',
              files: [{ file: 'Brief.md', kind: 'brief' }],
              description: 'Brief.md: the requirement brief written in the interview stage',
            },
            {
              id: 'research',
              files: [
                { file: 'Research.md', kind: 'research' },
                { file: 'System Design.md', kind: 'design' },
              ],
              description: 'Research.md: research and spec based on the brief',
            },
            {
              id: 'plan',
              files: [
                { file: 'Research.md', kind: 'research' },
                { file: 'System Design.md', kind: 'design' },
              ],
              description: 'The locked plan (the Plan section of Research.md, or System Design.md)',
              lockedPlan: true,
            },
            {
              id: 'tickets',
              files: [{ file: 'Tickets.md', kind: 'tickets' }],
              description: 'Tickets.md and the tickets this run created in Linear',
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
    done: 'In its latest turn the agent reported that the PR is marked ready for review (the ticket moved to the review state); or the agent explicitly reported that it cannot continue.',
    grading: ['hidden-tests', 'criteria-judge', 'pr-endpoint'],
  }),
};

// The configuration a workflow uses at run time: the entry command is /<workflowId>
export const evalSpec = (kind: EvalKind, workflowId: string): EvalSpec => ({
  ...EVAL_KINDS[kind],
  id: workflowId,
});

// Task fields determined by the eval kind (16.3)
export const taskFieldsOfKind = (kind: EvalKind): TaskFieldName[] => taskFieldsOf(EVAL_KINDS[kind]);

// The value of {entry} in the initial message
export const entryOf = (workflowId: string) => `/${workflowId}`;
