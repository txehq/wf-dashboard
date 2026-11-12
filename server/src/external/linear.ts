import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { config } from '../config.js';
import type { TicketTask } from '../tasks/schema.js';

// Launched the same way as txe-workflow's workflow/mcps/linear.yaml; mcp-remote reads the OAuth token from ~/.mcp-auth
export const LINEAR_MCP_URL = 'https://mcp.linear.app/mcp';
export const EVAL_TEAM = 'TXE';
export const EVAL_PROJECT = 'Workflow Eval';
export const EVAL_LABEL = 'eval';

// mcp-remote names the token file after the md5 of the server URL
const tokensPath = path.join(
  os.homedir(),
  '.mcp-auth/mcp-remote-v1',
  `${createHash('md5').update(LINEAR_MCP_URL).digest('hex')}_tokens.json`,
);

export function linearLoggedIn(): boolean {
  return fs.existsSync(tokensPath);
}

interface Connection {
  client: Promise<Client>;
  // mcp-remote is not started when not logged in
  transport: StdioClientTransport | null;
}

function connect(onLost: () => void): Connection {
  // When not logged in, mcp-remote opens a browser to wait for authorization and the process hangs forever
  if (config.linearMcp === null && !linearLoggedIn()) {
    return {
      client: Promise.reject(new Error(`Linear not logged in: ${tokensPath} does not exist`)),
      transport: null,
    };
  }
  const [command, ...args] = config.linearMcp ?? ['npx', '-y', 'mcp-remote', LINEAR_MCP_URL];
  if (command === undefined) throw new Error('The Linear MCP command is empty');
  const transport = new StdioClientTransport({ command, args, stderr: 'pipe' });
  // mcp-remote prints trace lines like [pid] [Local→Remote] for every call; the rest (auth prompts, errors) are
  // forwarded and kept: when the connection is not established (e.g. npx missing, mcp-remote exits at once) they are the failure text
  const stderr = transport.stderr;
  if (!(stderr instanceof Readable)) throw new Error('mcp-remote stderr is not piped');
  const output: string[] = [];
  readline.createInterface({ input: stderr }).on('line', (line) => {
    if (!/^\[\d+\] \[(Local→Remote|Remote→Local)\]/.test(line)) {
      process.stderr.write(`[mcp-remote] ${line}\n`);
      output.push(line);
    }
  });
  const c = new Client({ name: 'wf-dashboard', version: '0.0.0' });
  // The mcp-remote child process exited, or a stdio pipe failed
  c.onclose = onLost;
  c.onerror = onLost;
  // When the child exits stderr is fully read (Node emits close only after all stdio closes), so the kept output is complete
  const client = c.connect(transport).then(
    () => c,
    (error: unknown) => {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; mcp-remote output: ${output.join('\n') || '(none)'}`,
        { cause: error },
      );
    },
  );
  return { client, transport };
}

// Process-wide singleton: one mcp-remote child shared by all runs. A lost connection is dropped and the next call opens a new one:
// connect failure (e.g. not logged in yet), mcp-remote child exit, transport error, or a call throwing a transport-level error
// (after a network outage mcp-remote returns -32001 fetch failed for every call while the child keeps running).
// No retry: that call fails with the original error. A dropped connection closes after its in-flight calls; late events of the old one do not affect the new one
interface Entry {
  connection: Connection;
  calls: number;
  dropped: boolean;
}

let current: Entry | undefined;

function open(): Entry {
  const connection = connect(() => {
    drop(entry);
  });
  const entry: Entry = { connection, calls: 0, dropped: false };
  // A connect failure is thrown by the calls waiting on this connection
  entry.connection.client.then(undefined, () => {
    drop(entry);
  });
  current = entry;
  return entry;
}

function drop(entry: Entry) {
  if (current === entry) current = undefined;
  if (entry.dropped) return;
  entry.dropped = true;
  closeWhenIdle(entry);
}

function closeWhenIdle(entry: Entry) {
  if (!entry.dropped || entry.calls > 0) return;
  void entry.connection.client.then(
    (c) => c.close(),
    // Never connected, so there is no child process to close
    () => undefined,
  );
}

export function linearClient(): Promise<Client> {
  return (current ?? open()).connection.client;
}

// The environment check's "Recheck": later calls use a new connection; the old one closes after its in-flight calls
export function renewLinearClient() {
  if (current !== undefined) drop(current);
  open();
}

// Whether there is a connection for calls to use (connecting or connected)
export function hasLinearConnection(): boolean {
  return current !== undefined;
}

// pid of the current connection's mcp-remote child (npx); null when there is no connection yet
export async function linearConnectionPid(): Promise<number | null> {
  const entry = current;
  if (entry === undefined) return null;
  await entry.connection.client;
  return entry.connection.transport?.pid ?? null;
}

export async function closeLinearClient(): Promise<void> {
  const entry = current;
  if (entry === undefined) return;
  current = undefined;
  entry.dropped = true;
  const c = await entry.connection.client;
  await c.close();
}

const ToolResult = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }).loose()),
});

// A Linear MCP tool result is a JSON text; the SDK returns isError as is and does not throw.
// callTool throws transport-level errors: drop the connection, then rethrow
export async function callLinear<T>(
  name: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  const entry = current ?? open();
  entry.calls += 1;
  const raw = await entry.connection.client
    .then((c) => c.callTool({ name, arguments: args }))
    .then(
      (value) => value,
      (error: unknown) => {
        drop(entry);
        throw error;
      },
    )
    .finally(() => {
      entry.calls -= 1;
      closeWhenIdle(entry);
    });
  const result = ToolResult.parse(raw);
  const text = result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  if (result.isError === true) throw new Error(`Linear ${name} failed: ${text}`);
  return schema.parse(JSON.parse(text));
}

// Pagination of list tools: { <key>: [...], hasNextPage, cursor }
export async function listAll<T>(
  name: string,
  args: Record<string, unknown>,
  key: string,
  item: z.ZodType<T>,
): Promise<T[]> {
  const Page = z.object({ hasNextPage: z.boolean(), cursor: z.string().optional() }).loose();
  const items: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await callLinear(name, cursor === undefined ? args : { ...args, cursor }, Page);
    items.push(...z.array(item).parse(page[key]));
    if (!page.hasNextPage) return items;
    if (page.cursor === undefined)
      throw new Error(`Linear ${name} hasNextPage is true but there is no cursor`);
    cursor = page.cursor;
  }
}

const Team = z.object({ id: z.string(), key: z.string(), name: z.string() }).loose();
const Project = z.object({ id: z.string(), uuid: z.string(), name: z.string() }).loose();
const Label = z.object({ id: z.string(), name: z.string() }).loose();
const Status = z.object({ id: z.string(), type: z.string(), name: z.string() });
export type Status = z.infer<typeof Status>;

export interface EvalContainer {
  teamId: string;
  // project identifier (P-TXE-17)
  projectId: string;
  projectUuid: string;
  labelId: string;
  statuses: Status[];
}

function single<T extends { name: string }>(items: T[], name: string, kind: string): T | undefined {
  // list query / name is a fuzzy search, so compare names exactly
  const exact = items.filter((i) => i.name === name);
  if (exact.length > 1)
    throw new Error(`Linear has ${String(exact.length)} ${kind}s named ${name}`);
  return exact[0];
}

// Uncached: find the project and label by name, creating them when missing
export async function findOrCreateEvalContainer(): Promise<EvalContainer> {
  const team = await callLinear('get_team', { query: EVAL_TEAM }, Team);
  const projects = await listAll(
    'list_projects',
    { query: EVAL_PROJECT, team: EVAL_TEAM, includeArchived: false },
    'projects',
    Project,
  );
  const project =
    single(projects, EVAL_PROJECT, 'project') ??
    (await callLinear(
      'save_project',
      {
        name: EVAL_PROJECT,
        setTeams: [EVAL_TEAM],
        summary: 'Tickets created by Magi workflow dashboard eval runs',
      },
      Project,
    ));
  const labels = await listAll(
    'list_issue_labels',
    { name: EVAL_LABEL, team: EVAL_TEAM },
    'labels',
    Label,
  );
  // A team label needs the team UUID; the team key is not accepted
  const label =
    single(labels, EVAL_LABEL, 'label') ??
    (await callLinear(
      'save_issue_label',
      {
        name: EVAL_LABEL,
        teamId: team.id,
        color: '#8B5CF6',
        description: 'Created by Magi workflow dashboard eval runs',
      },
      Label,
    ));
  const statuses = await callLinear('list_issue_statuses', { team: EVAL_TEAM }, z.array(Status));
  return {
    teamId: team.id,
    projectId: project.id,
    projectUuid: project.uuid,
    labelId: label.id,
    statuses,
  };
}

let container: Promise<EvalContainer> | undefined;

// The "Workflow Eval" project and eval label under the TXE team; resolved once per process
export function ensureEvalContainer(): Promise<EvalContainer> {
  container ??= findOrCreateEvalContainer();
  return container;
}

export interface RunTicket {
  identifier: string;
  uuid: string;
  url: string;
}

const SavedIssue = z.object({ id: z.string(), uuid: z.string(), url: z.string() }).loose();

export function runTicketDescription(task: TicketTask, runId: string): string {
  // Task imported from Linear: the copy's body is all of ticket.body (which already has the acceptance criteria) plus the run id;
  // the source ticket id, repo and PR never appear (Contracts section 13); the source is only in task.yaml and the run record
  if (task.source !== undefined) {
    return [task.ticket.body, '', `run id: \`${runId}\``].join('\n');
  }
  return [
    task.ticket.body.trim(),
    '',
    '## Acceptance criteria',
    '',
    // Continuation lines of a multi-line criterion (e.g. a nested list) are indented inside the checklist item
    ...task.ticket.acceptanceCriteria.map((c) => `- [ ] ${c.replaceAll('\n', '\n  ')}`),
    '',
    `run id: \`${runId}\``,
  ].join('\n');
}

export async function createRunTicket(task: TicketTask, runId: string): Promise<RunTicket> {
  const { projectId } = await ensureEvalContainer();
  // The id returned by get_issue / save_issue is the identifier (TXE-N); the database id is in uuid
  const issue = await callLinear(
    'save_issue',
    {
      team: EVAL_TEAM,
      project: projectId,
      // An imported task's id defaults to one derived from the source ticket id (ic-txe-3635), so it stays out of the copy's title
      title:
        task.source === undefined
          ? `[eval] ${task.id} ${runId} ${task.ticket.title}`
          : `[eval] ${runId} ${task.ticket.title}`,
      description: runTicketDescription(task, runId),
      labels: [EVAL_LABEL],
      state: 'Todo',
    },
    SavedIssue,
  );
  return { identifier: issue.id, uuid: issue.uuid, url: issue.url };
}

const Issue = z
  .object({
    id: z.string(),
    url: z.string(),
    status: z.string(),
    statusType: z.string(),
    stateHistory: z.array(
      z.object({
        state: z.object({ name: z.string() }).loose(),
        startedAt: z.string(),
        endedAt: z.string().nullable(),
      }),
    ),
  })
  .loose();

const Comment = z
  .object({
    id: z.string(),
    body: z.string(),
    createdAt: z.string(),
    author: z.object({ name: z.string() }).loose(),
  })
  .loose();

export interface Ticket {
  identifier: string;
  status: string;
  statusType: string;
  url: string;
  stateHistory: { state: string; startedAt: string; endedAt: string | null }[];
  comments: { id: string; body: string; author: string; createdAt: string }[];
}

export async function readTicket(identifier: string): Promise<Ticket> {
  const issue = await callLinear('get_issue', { id: identifier }, Issue);
  const comments = await listAll('list_comments', { issueId: identifier }, 'comments', Comment);
  return {
    identifier: issue.id,
    status: issue.status,
    statusType: issue.statusType,
    url: issue.url,
    stateHistory: issue.stateHistory.map((h) => ({
      state: h.state.name,
      startedAt: h.startedAt,
      endedAt: h.endedAt,
    })),
    comments: comments
      .map((c) => ({ id: c.id, body: c.body, author: c.author.name, createdAt: c.createdAt }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  };
}

const IssueContent = z.object({
  id: z.string(),
  title: z.string(),
  // An explicitly requested field with no value is null
  description: z.string().nullable(),
  url: z.string(),
  createdAt: z.string(),
});
export type IssueContent = z.infer<typeof IssueContent>;

// A ticket's title and body, for grading the tickets artifact
export async function readIssueContent(identifier: string): Promise<IssueContent> {
  return callLinear(
    'get_issue',
    { id: identifier, fields: ['title', 'description', 'url', 'createdAt'] },
    IssueContent,
  );
}

// The following import ic tasks from Linear (Contracts section 13): read-only, the original ticket is untouched; comments are not imported

const IssueForImport = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  url: z.string(),
  status: z.string(),
  project: z.string().nullable(),
  team: z.string(),
  attachments: z.array(z.object({ title: z.string(), url: z.string() }).loose()),
});

export interface IssueForImport {
  identifier: string;
  title: string;
  // The raw markdown Linear returns; an empty string when the body is empty
  description: string;
  url: string;
  status: string;
  project: string | null;
  team: string;
  attachmentUrls: string[];
}

// The ticket for import: title, raw body, status and attachment links. For a missing ticket, get_issue's own text is the error
export async function readIssueForImport(identifier: string): Promise<IssueForImport> {
  const issue = await callLinear(
    'get_issue',
    {
      id: identifier,
      fields: ['id', 'title', 'description', 'url', 'status', 'project', 'team', 'attachments'],
    },
    IssueForImport,
  );
  return {
    identifier: issue.id,
    title: issue.title,
    description: issue.description ?? '',
    url: issue.url,
    status: issue.status,
    project: issue.project,
    team: issue.team,
    attachmentUrls: issue.attachments.map((a) => a.url),
  };
}
