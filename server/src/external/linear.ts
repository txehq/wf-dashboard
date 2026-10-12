import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import type { TicketTask } from '../tasks/schema.js';

// 与 txe-workflow 的 workflow/mcps/linear.yaml 相同的启动方式；OAuth token 由 mcp-remote 从 ~/.mcp-auth 读取
export const LINEAR_MCP_URL = 'https://mcp.linear.app/mcp';
export const EVAL_TEAM = 'TXE';
export const EVAL_PROJECT = 'Workflow Eval';
export const EVAL_LABEL = 'eval';

// mcp-remote 以服务器 URL 的 md5 命名 token 文件
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
  // 没有登录时不启动 mcp-remote
  transport: StdioClientTransport | null;
}

function connect(onLost: () => void): Connection {
  // 未登录时 mcp-remote 会打开浏览器等待授权，进程会一直挂起
  if (!linearLoggedIn()) {
    return {
      client: Promise.reject(new Error(`Linear 未登录：${tokensPath} 不存在`)),
      transport: null,
    };
  }
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', 'mcp-remote', LINEAR_MCP_URL],
    stderr: 'pipe',
  });
  // mcp-remote 对每次调用打印 [pid] [Local→Remote] 一类的跟踪行；其余（授权提示、错误）照常转发
  const stderr = transport.stderr;
  if (!(stderr instanceof Readable)) throw new Error('mcp-remote 的 stderr 没有建立管道');
  readline.createInterface({ input: stderr }).on('line', (line) => {
    if (!/^\[\d+\] \[(Local→Remote|Remote→Local)\]/.test(line)) {
      process.stderr.write(`[mcp-remote] ${line}\n`);
    }
  });
  const c = new Client({ name: 'wf-dashboard', version: '0.0.0' });
  // mcp-remote 子进程退出、stdio 管道出错
  c.onclose = onLost;
  c.onerror = onLost;
  return { client: c.connect(transport).then(() => c), transport };
}

// 进程内单例：一个 mcp-remote 子进程，所有 run 共用。连接断开时丢弃这个连接，下一次调用新建：
// 连接失败（例如还没有登录）、mcp-remote 子进程退出、transport 出错、调用抛出 transport 层的错误
// （网络中断后 mcp-remote 对每次调用返回 -32001 fetch failed，子进程本身不退出）。
// 不重试：当次调用以原文失败。被丢弃的连接在进行中的调用结束后关闭；旧连接迟到的事件不影响新连接
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
  // 连接失败的错误由等待这个连接的调用抛出
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
    // 连接没有建立，没有可关闭的子进程
    () => undefined,
  );
}

export function linearClient(): Promise<Client> {
  return (current ?? open()).connection.client;
}

// 环境检查的"重新检查"：之后的调用都用新建的连接；旧连接在进行中的调用结束后关闭
export function renewLinearClient() {
  if (current !== undefined) drop(current);
  open();
}

// 是否有给调用使用的连接（建立中或已建立）
export function hasLinearConnection(): boolean {
  return current !== undefined;
}

// 当前连接的 mcp-remote 子进程（npx）的 pid；还没有连接时为 null
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

// Linear MCP 的 tool 结果是一段 JSON 文本；isError 由 SDK 原样返回，不会抛出。
// callTool 抛出的是 transport 层的错误：丢弃这个连接后照常抛出
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
  if (result.isError === true) throw new Error(`Linear ${name} 失败：${text}`);
  return schema.parse(JSON.parse(text));
}

// 列表类 tool 的分页：{ <key>: [...], hasNextPage, cursor }
async function listAll<T>(
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
      throw new Error(`Linear ${name} hasNextPage 为 true 但没有 cursor`);
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
  // project identifier（P-TXE-17）
  projectId: string;
  projectUuid: string;
  labelId: string;
  statuses: Status[];
}

function single<T extends { name: string }>(items: T[], name: string, kind: string): T | undefined {
  // list 的 query / name 是模糊搜索，按名字精确比较
  const exact = items.filter((i) => i.name === name);
  if (exact.length > 1)
    throw new Error(`Linear 中有 ${String(exact.length)} 个名为 ${name} 的 ${kind}`);
  return exact[0];
}

// 不带缓存：按名字查找 project 与 label，不存在则创建
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
        summary: 'Magi workflow dashboard 评估运行创建的工单',
      },
      Project,
    ));
  const labels = await listAll(
    'list_issue_labels',
    { name: EVAL_LABEL, team: EVAL_TEAM },
    'labels',
    Label,
  );
  // team 级 label 必须传 team 的 UUID，team key 不被接受
  const label =
    single(labels, EVAL_LABEL, 'label') ??
    (await callLinear(
      'save_issue_label',
      {
        name: EVAL_LABEL,
        teamId: team.id,
        color: '#8B5CF6',
        description: 'Magi workflow dashboard 评估运行创建',
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

// TXE team 下的 "Workflow Eval" project 与 eval label；进程内只解析一次
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
  // 从 Linear 导入的 task：副本正文是 ticket.body 的全部内容（其中已有验收标准一节）加 run id；
  // 不出现来源工单编号、来源仓库与来源 PR（Contracts 第 13 节），来源只记在 task.yaml 与 run 记录
  if (task.source !== undefined) {
    return [task.ticket.body, '', `run id: \`${runId}\``].join('\n');
  }
  return [
    task.ticket.body.trim(),
    '',
    '## Acceptance criteria',
    '',
    // 多行的验收标准（例如带嵌套列表）续行缩进到清单项之内
    ...task.ticket.acceptanceCriteria.map((c) => `- [ ] ${c.replaceAll('\n', '\n  ')}`),
    '',
    `run id: \`${runId}\``,
  ].join('\n');
}

export async function createRunTicket(task: TicketTask, runId: string): Promise<RunTicket> {
  const { projectId } = await ensureEvalContainer();
  // get_issue / save_issue 返回的 id 就是 identifier（TXE-N），数据库 id 在 uuid
  const issue = await callLinear(
    'save_issue',
    {
      team: EVAL_TEAM,
      project: projectId,
      // 导入的 task 的 id 默认由来源工单编号得出（ic-txe-3635），副本标题中不放
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
  // 显式请求的字段没有值时为 null
  description: z.string().nullable(),
  url: z.string(),
  createdAt: z.string(),
});
export type IssueContent = z.infer<typeof IssueContent>;

// 工单的标题与正文，供 tickets 产物的评分使用
export async function readIssueContent(identifier: string): Promise<IssueContent> {
  return callLinear(
    'get_issue',
    { id: identifier, fields: ['title', 'description', 'url', 'createdAt'] },
    IssueContent,
  );
}

// 以下供从 Linear 导入 ic task（Contracts 第 13 节）：只读取，不改动原工单；评论不导入

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
  // Linear 返回的 markdown 原文；正文为空时为空字符串
  description: string;
  url: string;
  status: string;
  project: string | null;
  team: string;
  attachmentUrls: string[];
}

// 导入用的工单：标题、正文原文、状态与附件链接。工单不存在时 get_issue 的原文即错误
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
