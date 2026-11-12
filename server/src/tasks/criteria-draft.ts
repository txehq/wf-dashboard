import type { RootContent } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toString } from 'mdast-util-to-string';
import { z } from 'zod';
import { models, parseStructured, type StructuredRequest } from '../llm/client.js';
import { isFiller } from '../llm/filler.js';

// The judge reads the ticket title and full body to determine the acceptance criteria (Contracts section 13); quote is the body excerpt the criterion rests on

// The two Chinese section titles user-written tickets use ("acceptance criteria", "acceptance conditions")
const ZH_CRITERIA = '\u{9A8C}\u{6536}\u{6807}\u{51C6}';
const ZH_CONDITIONS = '\u{9A8C}\u{6536}\u{6761}\u{4EF6}';

const system = `You compile the acceptance criteria of a ticket for an evaluation system for AI coding workflows. During evaluation another grader checks each criterion to decide whether the PR the agent opened satisfies the ticket.

Rules:
- When the body has an explicit acceptance criteria section (a heading or bold paragraph title such as "${ZH_CRITERIA}", "${ZH_CONDITIONS}", "Acceptance criteria" or "Acceptance", followed by a list): each list item of that section is one criterion, taken verbatim in the original order. text is the original text of the list item, not rewritten, translated, merged or split; remove the list marker ("-", "*", "1.") and task checkbox ("[ ]", "[x]") and keep all the remaining text, including numbering such as AC1, backticks of inline code and punctuation.
- When the body has no such section: compile checkable items from the body's problem description, fix requirements and test requirements. Each item is a concrete requirement that can be judged "met / partly met / not met" against the PR's diff and CI results; write only requirements grounded in the body, add none the body does not have, and do not repeat items. Write text in the language of the body.
- quote is the body excerpt this criterion rests on: copy one continuous piece of text verbatim from the body (a sentence or part of a list item); it must match the body exactly, including case, punctuation, spaces and backticks; do not cross line breaks and do not omit text in the middle.
- You must call respond to give the result: criteria in order.`;

const Output = z.object({
  criteria: z.array(z.object({ text: z.string().min(1), quote: z.string().min(1) })).min(1),
});
type Output = z.infer<typeof Output>;

export interface DraftedCriterion {
  text: string;
  quote: string;
}

export interface CriteriaDraft {
  criteria: DraftedCriterion[];
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

// Same titles as "an explicit acceptance criteria section" in the prompt: a heading line, or a paragraph that is only bold text (optionally with a colon)
const SECTION_TITLE = new RegExp(
  `^(?:${ZH_CRITERIA}|${ZH_CONDITIONS}|acceptance criteria|acceptance)\\s*[:\\u{FF1A}]?$`,
  'iu',
);

const isBoldTitle = (node: RootContent) =>
  node.type === 'paragraph' && node.children.length === 1 && node.children[0]?.type === 'strong';

const isSectionTitle = (node: RootContent) =>
  (node.type === 'heading' || isBoldTitle(node)) && SECTION_TITLE.test(toString(node).trim());

// Number of list items in the body's acceptance criteria section: from that section to the next heading of the same or higher level (for a bold title, to the next heading or bold title),
// the sum of the top-level items of its lists. null when there is no such section or it has no list; throws when there are two such sections
export function criteriaSectionItemCount(body: string): number | null {
  const nodes = fromMarkdown(body).children;
  const starts = nodes.flatMap((node, i) => (isSectionTitle(node) ? [i] : []));
  if (starts.length > 1) {
    throw new Error(`The body has ${String(starts.length)} acceptance criteria sections, so which one applies cannot be determined`);
  }
  const start = starts[0];
  if (start === undefined) return null;
  const title = nodes[start];
  if (title === undefined) return null;
  let count = 0;
  let lists = 0;
  for (const node of nodes.slice(start + 1)) {
    if (node.type === 'heading' && (title.type !== 'heading' || node.depth <= title.depth)) break;
    if (title.type !== 'heading' && isBoldTitle(node)) break;
    if (node.type === 'list') {
      lists += 1;
      count += node.children.length;
    }
  }
  return lists === 0 ? null : count;
}

export function criteriaDraftRequest(
  title: string,
  body: string,
  model: string,
): StructuredRequest<Output> {
  return {
    model,
    system,
    user: `Ticket title: ${title}\n\nThe full ticket body follows, between <body> tags:\n<body>\n${body}\n</body>`,
    schema: Output,
    maxTokens: 8000,
  };
}

// Throws with the exact text when a quote is not a substring of the body, a text is filler, or the body has an acceptance criteria section and the count differs from its list items
export function readCriteriaDraft(body: string, output: Output): DraftedCriterion[] {
  const expected = criteriaSectionItemCount(body);
  if (expected !== null && output.criteria.length !== expected) {
    throw new Error(
      `The judge gave ${String(output.criteria.length)} acceptance criteria, but the body's acceptance criteria section has ${String(expected)} list items`,
    );
  }
  return output.criteria.map((c, i) => {
    const n = String(i + 1);
    if (isFiller(c.text)) {
      throw new Error(`The text the judge gave for acceptance criterion ${n} is filler: ${JSON.stringify(c.text)}`);
    }
    if (!body.includes(c.quote)) {
      throw new Error(`The quote the judge gave for acceptance criterion ${n} is not verbatim body text: ${JSON.stringify(c.quote)}`);
    }
    return { text: c.text, quote: c.quote };
  });
}

// With an empty body there is no text to rest on: the judge is not called and the user fills in the form
export async function draftCriteria(title: string, body: string): Promise<CriteriaDraft> {
  if (body.trim() === '') {
    return { criteria: [], model: models.judge, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  }
  const result = await parseStructured(criteriaDraftRequest(title, body, models.judge));
  return {
    criteria: readCriteriaDraft(body, result.value),
    model: result.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUsd: result.costUsd,
  };
}
