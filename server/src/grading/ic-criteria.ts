import { z } from 'zod';
import {
  icEndpoint,
  prBranch,
  prChecks,
  prDescription,
  prDiff,
  readPr,
} from '../external/github.js';
import { models, parseStructured, type StructuredRequest } from '../llm/client.js';
import type { TokenUsage } from '../llm/pricing.js';
import type { IcTask } from '../tasks/schema.js';
import { checkReasoning, itemKey } from './rubric-judge.js';
import type { GradeItem, IcCriteriaDetail } from './schema.js';

// 0 未满足、1 部分满足、2 满足（Contracts 第 13 节）
export const CRITERION_MAX = 2;

const system = `你是一个 AI 编码 workflow 评估系统的评分员。被评估的是 Magi workflow 的 /ic 流程：agent 拿到一张工单，在仓库副本中实现后开出 PR。你要判断这个 PR 是否满足工单的每一条验收标准。

评分规则：
- 严格按验收标准逐条评分：每一条都要评，只评列出的条目，条目之间互不影响，不给整体印象分。
- 依据只有 PR 的 diff、PR 的标题与正文、CI 各 check 的结果。PR 正文中的说法只有在 diff 或 check 结果能印证时才算数；diff 中没有出现的改动一律视为没有做，不替 agent 推测意图。
- 需要运行才能确认的标准（例如"测试通过"），以对应 check 的结果为准；check 没有运行或没有结论时，只能依据 diff 判断能否满足，并在理由中说明。
- score 只取 0、1、2：0 表示未满足，1 表示部分满足，2 表示满足。
- reasoning 用中文写一到三句：指出 diff 中支持该分数的具体改动（文件、函数或测试，可以短引原文），或指出缺少的内容。
- 按条目编号作答：respond 的参数中 item_1 是验收标准 1 的评分，item_2 是验收标准 2 的评分，依此类推，每个条目都有 reasoning 与 score。`;

interface JudgeInput {
  task: IcTask;
  pr: { number: number; url: string; title: string; body: string };
  checks: IcCriteriaDetail['checks'];
  diff: string;
}

function userPrompt({ task, pr, checks, diff }: JudgeInput) {
  const criteria = task.ticket.acceptanceCriteria
    .map((c, n) => `- 验收标准 ${String(n + 1)}：${c}`)
    .join('\n');
  const required = task.requiredChecks.length === 0 ? '（没有）' : task.requiredChecks.join('、');
  const checkLines =
    checks.length === 0
      ? '（PR 的 head 上没有任何 check）'
      : checks.map((c) => `- ${c.name}：${c.bucket}（${c.state}）`).join('\n');
  return `工单标题：${task.ticket.title}

工单正文：
${task.ticket.body}

验收标准（${String(task.ticket.acceptanceCriteria.length)} 条）：
${criteria}

PR #${String(pr.number)}：${pr.title}
${pr.url}

PR 正文：
${pr.body.trim() === '' ? '（空）' : pr.body}

CI 各 check 的结果（终点要求通过的 check：${required}；其余 check 在仓库副本中可能没有 runner，不计入终点）：
${checkLines}

PR 的完整 diff 如下，位于 <diff> 标签之间：
<diff>
${diff}
</diff>`;
}

const JudgedCriterion = z.object({ reasoning: z.string().min(1), score: z.int() });
type Judgment = Record<string, z.infer<typeof JudgedCriterion>>;

export function criteriaSchema(task: IcTask) {
  return z.object(
    Object.fromEntries(task.ticket.acceptanceCriteria.map((_, i) => [itemKey(i), JudgedCriterion])),
  );
}

export const criterionId = (index: number) => `ac${String(index + 1)}`;

// diff 不截断：超过 judge 的上下文时 gateway 的错误原文就是评分失败的原因
export function criteriaRequest(input: JudgeInput, model: string): StructuredRequest<Judgment> {
  return {
    model,
    system,
    user: userPrompt(input),
    schema: criteriaSchema(input.task),
    maxTokens: 8000,
  };
}

// 按编号把回答对应回验收标准；缺少条目、reasoning 是占位内容或没有写完、分数不是 0 / 1 / 2 时抛错
export function readCriteriaJudgment(task: IcTask, judgment: Judgment): GradeItem[] {
  return task.ticket.acceptanceCriteria.map((criterion, i): GradeItem => {
    const itemId = criterionId(i);
    const judged = judgment[itemKey(i)];
    if (judged === undefined) throw new Error(`judge 没有返回验收标准 ${itemId}`);
    checkReasoning(itemId, judged.reasoning);
    if (judged.score < 0 || judged.score > CRITERION_MAX) {
      throw new Error(`judge 给 ${itemId} 的分数 ${String(judged.score)} 不是 0、1、2`);
    }
    return {
      itemId,
      criterion,
      score: judged.score,
      maxScore: CRITERION_MAX,
      reasoning: judged.reasoning,
    };
  });
}

export interface IcCriteriaResult {
  items: GradeItem[];
  reachedEnd: boolean;
  judge: { model: string; usage: TokenUsage; costUsd: number } | null;
  detail: IcCriteriaDetail;
}

// 没有隐藏测试的 ic task：仓库中最新的 PR 交给 judge 按验收标准逐条评分，终点判定读同一个 head；
// 没有 PR 时每条记 0 分、终点为否，不调用 judge。signal 取消时在下一步之前抛出 signal.reason
export async function gradeIcCriteria(
  task: IcTask,
  repo: string,
  signal: AbortSignal,
): Promise<IcCriteriaResult> {
  const pr = await readPr(repo);
  signal.throwIfAborted();
  if (pr === null) {
    return {
      items: task.ticket.acceptanceCriteria.map((criterion, i) => ({
        itemId: criterionId(i),
        criterion,
        score: 0,
        maxScore: CRITERION_MAX,
        reasoning: '该 run 没有建出 PR，该条记 0 分。',
      })),
      reachedEnd: false,
      judge: null,
      detail: { pr: null, endpoint: null, checks: [], diffChars: 0 },
    };
  }
  const branch = await prBranch(repo, pr.number);
  const description = await prDescription(repo, pr.number);
  const diff = await prDiff(repo, pr.number);
  const checks = await prChecks(repo, pr.number);
  const endpoint = await icEndpoint(repo, pr.number, task.requiredChecks);
  if (endpoint.head !== description.headRefOid) {
    throw new Error(
      `${repo}#${String(pr.number)} 的 head 在评分期间变化：${description.headRefOid} → ${endpoint.head}`,
    );
  }
  signal.throwIfAborted();
  const result = await parseStructured({
    ...criteriaRequest(
      {
        task,
        pr: { number: pr.number, url: pr.url, title: description.title, body: description.body },
        checks,
        diff,
      },
      models.judge,
    ),
    signal,
  });
  return {
    items: readCriteriaJudgment(task, result.value),
    reachedEnd: endpoint.reached,
    judge: { model: result.model, usage: result.usage, costUsd: result.costUsd },
    detail: {
      pr: { number: pr.number, url: pr.url, branch, head: endpoint.head },
      endpoint,
      checks,
      diffChars: diff.length,
    },
  };
}
