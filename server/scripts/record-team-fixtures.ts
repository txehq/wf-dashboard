import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { format, resolveConfig } from 'prettier';
import { z } from 'zod';
import { config } from '../src/config.js';
import { closeLinearClient, linearClient } from '../src/external/linear.js';
import { prRef } from '../src/team/github.js';
import { ISSUE_FIELDS, listDiffsArgs, listIssuesArgs } from '../src/team/linear.js';

// Record the real responses the Linear stats sync reads (Contracts 37.2) for a few TXE issues chosen by list_issues
// filters (parentId=TXE-123 for an epic's children, query=<text> state=<state> for a title search), replayed in tests
// by test/fixtures/team/linear-stand-in.mjs and test/fixtures/team/bin/gh. This records the Linear calls, then
// record-team-sync.ts runs the sync on them to record every gh call. Only reads Linear and GitHub.
// The incremental listing uses updatedAfter = the 4th most recent issue's updatedAt, so it lists the most recent ones
// Run: pnpm --filter @wf-dashboard/server record:team-fixtures <name> <filter>=<value>...
const [name, ...filters] = process.argv.slice(2);
if (name === undefined || filters.length === 0)
  throw new Error('Usage: record-team-fixtures.ts <name> <filter>=<value>...');
const dir = path.join(config.repoRoot, 'server/test/fixtures/team', name);
const scope = Object.fromEntries(
  filters.map((f) => {
    const [key, ...value] = f.split('=');
    if (key === undefined || value.length === 0) throw new Error(`Not <filter>=<value>: ${f}`);
    return [key, value.join('=')];
  }),
);

const client = await linearClient();
const Result = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
});
const calls: { name: string; args: Record<string, unknown>; isError: boolean; text: string }[] = [];
async function call(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const result = Result.parse(await client.callTool({ name: tool, arguments: args }));
  const text = result.content.map((c) => c.text).join('\n');
  const isError = result.isError === true;
  calls.push({ name: tool, args, isError, text });
  if (isError) throw new Error(`${tool} failed: ${text}`);
  return JSON.parse(text);
}

const Page = z.object({ hasNextPage: z.boolean(), cursor: z.string().optional() }).loose();
async function pages(
  tool: string,
  args: (cursor?: string) => Record<string, unknown>,
  key: string,
) {
  const items: unknown[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = Page.parse(await call(tool, args(cursor)));
    items.push(...z.array(z.unknown()).parse(page[key]));
    if (!page.hasNextPage) return items;
    cursor = page.cursor;
  }
}

const users = z
  .array(z.object({ id: z.string() }))
  .parse(
    await pages(
      'list_users',
      (cursor) => ({ limit: 250, ...(cursor === undefined ? {} : { cursor }) }),
      'users',
    ),
  );
const Listed = z.array(z.object({ id: z.string(), updatedAt: z.string() }));
const listed = Listed.parse(
  await pages('list_issues', (cursor) => listIssuesArgs('TXE', scope, null, cursor), 'issues'),
);
const recent = [...listed].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
const updatedAfter = new Date(recent[Math.min(3, recent.length - 1)]?.updatedAt ?? '');
const incremental = Listed.parse(
  await pages(
    'list_issues',
    (cursor) => listIssuesArgs('TXE', scope, updatedAfter, cursor),
    'issues',
  ),
);

const Issue = z.object({ attachments: z.array(z.object({ url: z.string() })) }).loose();
const refs = new Map<string, NonNullable<ReturnType<typeof prRef>>>();
for (const issue of listed) {
  const read = Issue.parse(await call('get_issue', { id: issue.id, fields: ISSUE_FIELDS }));
  for (const a of read.attachments) {
    const ref = prRef(a.url);
    if (ref !== null) refs.set(ref.url, ref);
  }
}
// The sync asks Linear which merged PRs each user authored, to find their GitHub login (37.3)
for (const user of users) await call('list_diffs', listDiffsArgs(user.id));
await closeLinearClient();

const writeJson = async (file: string, value: unknown) => {
  const options = await resolveConfig(file);
  fs.writeFileSync(file, await format(JSON.stringify(value), { ...options, filepath: file }));
};
fs.mkdirSync(dir, { recursive: true });
await writeJson(path.join(dir, 'linear.json'), { calls });
await writeJson(path.join(dir, 'gh.json'), { commands: [] });
await writeJson(path.join(dir, 'meta.json'), {
  scope,
  updatedAfter: updatedAfter.toISOString(),
  issues: listed.map((i) => i.id),
  updatedSince: incremental.map((i) => i.id),
  prs: [...refs.keys()],
  recordedAt: new Date().toISOString(),
});
console.log(
  `${name}: ${String(listed.length)} issues, ${String(incremental.length)} updated after ${updatedAfter.toISOString()}, ${String(refs.size)} PRs`,
);
await execa('tsx', [path.join(import.meta.dirname, 'record-team-sync.ts'), name], {
  preferLocal: true,
  stdio: 'inherit',
});
