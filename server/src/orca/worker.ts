import { z } from 'zod';
import { type OrcaPlace, orcaCall, orcaRead } from './cli.js';

// Workers Orca runs without a pane (Contracts 35.3, 35.4): since 1.4.246 a worker is by default a structured agent
// session, whose structworker_ handle no terminal verb accepts and no terminal list holds. Everything the page needs
// about such a worker comes from the Dispatch instead: worker-show for the agent Orca launched and its workspace,
// worker-read for the transcript, send for input and worker-stop for "Stop process"

// One field of Orca's launch options; the concise view 1.4.246 prints by default drops them all, so these are read
// from the full record
const Launch = z.object({
  agent: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
});

export const WorkerShow = z.object({
  worker: z.object({
    agentTerminalHandle: z.string().nullable(),
    // Orca's id for the workspace: "<repo id>::<path>"
    worktreeId: z.string(),
    startOptions: z.object({
      agent: z.string().nullable().optional(),
      launch: z
        .object({ requested: Launch.optional(), effective: Launch.optional() })
        .nullable()
        .optional(),
    }),
  }),
});

// What the dashboard keeps about one structured worker: where it works and what Orca launched there. None of it
// changes while the Dispatch lives, so it is read once per Dispatch
export interface StructuredWorker {
  dispatchId: string;
  handle: string;
  cwd: string;
  // The agent Orca launched (claude, codex) and what it was launched with; null when Orca names none
  agent: string | null;
  model: string | null;
  effort: string | null;
}

// Path inside Orca's workspace id
function worktreePath(worktreeId: string): string {
  const at = worktreeId.indexOf('::');
  if (at === -1) throw new Error(`Orca gave a workspace id with no path: ${worktreeId}`);
  return worktreeId.slice(at + 2);
}

export async function workerShow(
  place: OrcaPlace,
  version: string,
  dispatchId: string,
): Promise<StructuredWorker> {
  return structuredWorker(
    dispatchId,
    WorkerShow.parse(
      await orcaRead(place, version, ['orchestration', 'worker-show', '--dispatch', dispatchId]),
    ),
  );
}

// What one worker-show says about the worker: the agent is what Orca actually launched, else what the Dispatch
// asked to launch, else the Dispatch's own agent
export function structuredWorker(
  dispatchId: string,
  shown: z.infer<typeof WorkerShow>,
): StructuredWorker {
  const options = shown.worker.startOptions;
  const launch = options.launch ?? null;
  const effective = launch?.effective ?? null;
  const requested = launch?.requested ?? null;
  const handle = shown.worker.agentTerminalHandle;
  if (handle === null) throw new Error(`Orca worker ${dispatchId} has no terminal handle`);
  return {
    dispatchId,
    handle,
    cwd: worktreePath(shown.worker.worktreeId),
    agent: effective?.agent ?? requested?.agent ?? options.agent ?? null,
    model: effective?.model ?? requested?.model ?? null,
    effort: effective?.effort ?? requested?.effort ?? null,
  };
}

// One piece of a turn: the text the agent or the sender wrote, or one tool call with its result
export const WorkerPart = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({
    kind: z.literal('tool'),
    name: z.string(),
    // One line naming what the call acts on (the command, the file, the pattern), shown while the call is collapsed
    summary: z.string(),
    input: z.string(),
    // Null while the tool is still running
    output: z.string().nullable(),
    failed: z.boolean(),
  }),
]);
export type WorkerPart = z.infer<typeof WorkerPart>;

// Inputs whose value says what a call acts on, in the order they are looked for
const SUMMARY_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description'];

function toolSummary(input: unknown): string {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const fields = input as Record<string, unknown>;
    for (const key of SUMMARY_KEYS) {
      const value = fields[key];
      if (typeof value === 'string' && value.trim() !== '') return firstLine(value);
    }
  }
  return firstLine(JSON.stringify(input));
}

const firstLine = (text: string) => {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
};

// Who the turn is from: user holds the coordinator's task and messages and anything typed here, reasoning is the
// agent thinking, system is Orca's own note (a background command starting or finishing)
export const workerRoles = ['user', 'assistant', 'reasoning', 'system'] as const;

export const WorkerTurn = z.object({
  id: z.string(),
  at: z.number(),
  role: z.enum(workerRoles),
  parts: z.array(WorkerPart),
});
export type WorkerTurn = z.infer<typeof WorkerTurn>;

const Block = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool-call'),
    name: z.string(),
    input: z.unknown(),
    callId: z.string(),
  }),
  z.object({
    type: z.literal('tool-result'),
    output: z.string(),
    callId: z.string(),
    isError: z.boolean(),
  }),
  // Claude Code's background commands: the turn's text block already says what happened
  z.object({ type: z.literal('background-task'), taskId: z.string(), state: z.string() }),
]);

export const WorkerRead = z.object({
  dispatchId: z.string(),
  source: z.string(),
  transcript: z.object({
    messages: z.array(
      z.object({
        id: z.string(),
        timestamp: z.number(),
        role: z.enum(workerRoles),
        blocks: z.array(Block),
      }),
    ),
    // Where to continue reading; it stays the same while nothing new is written
    nextCursor: z.string().nullable(),
    returnedMessageCount: z.number().int(),
    // The page stopped at Orca's own page size (50 messages, whatever --limit asks for)
    limited: z.boolean(),
  }),
  status: z.object({ worker: z.string(), terminal: z.string(), liveness: z.string() }),
});
export type WorkerRead = z.infer<typeof WorkerRead>;

// The turns of one page: a tool call and its result are one part, matched by call id inside the turn
export function workerTurns(read: WorkerRead): WorkerTurn[] {
  return read.transcript.messages.map((message) => {
    const parts: WorkerPart[] = [];
    const calls = new Map<string, Extract<WorkerPart, { kind: 'tool' }>>();
    for (const block of message.blocks) {
      if (block.type === 'text') {
        parts.push({ kind: 'text', text: block.text });
      } else if (block.type === 'tool-call') {
        const call = {
          kind: 'tool' as const,
          name: block.name,
          summary: toolSummary(block.input),
          input: JSON.stringify(block.input, null, 2),
          output: null as string | null,
          failed: false,
        };
        calls.set(block.callId, call);
        parts.push(call);
      } else if (block.type === 'tool-result') {
        const call = calls.get(block.callId);
        if (call === undefined) {
          parts.push({
            kind: 'tool',
            name: 'result',
            summary: firstLine(block.output),
            input: '',
            output: block.output,
            failed: block.isError,
          });
          continue;
        }
        call.output = block.output;
        call.failed = block.isError;
      }
    }
    return { id: message.id, at: message.timestamp, role: message.role, parts };
  });
}

// One page of a worker's transcript (Contracts 35.4): with a cursor only what was written since it, so the page polls
// incrementally. The returned cursor is pinned to this source; it is passed back unchanged. more says the page was cut
// at Orca's page size with messages in it, so the reader reads again at once instead of waiting for the next poll
export async function workerRead(
  place: OrcaPlace,
  version: string,
  dispatchId: string,
  cursor: string | null,
): Promise<WorkerPage> {
  return workerPage(
    WorkerRead.parse(
      await orcaRead(place, version, [
        'orchestration',
        'worker-read',
        '--dispatch',
        dispatchId,
        '--source',
        'transcript',
        '--limit',
        '200',
        ...(cursor === null ? [] : ['--cursor', cursor]),
      ]),
    ),
  );
}

export interface WorkerPage {
  turns: WorkerTurn[];
  cursor: string | null;
  more: boolean;
  status: WorkerRead['status'];
}

export function workerPage(read: WorkerRead): WorkerPage {
  return {
    turns: workerTurns(read),
    cursor: read.transcript.nextCursor,
    more: read.transcript.limited && read.transcript.returnedMessageCount > 0,
    status: read.status,
  };
}

// What Orca did with a message sent to a Dispatch: delivered reaches the running worker, reopened started a new one
// (Orca's answer to a message for a worker that already finished), and names the Dispatch that now carries it
export const WorkerSend = z.object({
  delivery: z.string(),
  dispatchId: z.string().optional(),
});

// Input typed on the page (Contracts 35.4): a structured worker takes no terminal input, so it arrives as a message to
// its Dispatch
export async function workerSend(
  place: OrcaPlace,
  dispatchId: string,
  subject: string,
  body: string,
): Promise<z.infer<typeof WorkerSend>> {
  return WorkerSend.parse(
    await orcaCall(place, [
      'orchestration',
      'send',
      '--to',
      `dispatch:${dispatchId}`,
      '--type',
      'status',
      '--subject',
      subject,
      '--body',
      body,
    ]),
  );
}
