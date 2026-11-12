import { useMutation, useQuery } from '@tanstack/react-query';
import { Bot, Brain, Info, SendHorizontal, UserRound, Wrench } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AgentText, Bubble, SystemLine } from '@/components/runs/conversation';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { formatTime } from '@/lib/format';
import { readWorker, sendToWorker, type WorkerTranscript, type WorkerTurn } from '@/lib/live-api';
import { cn } from '@/lib/utils';

// A worker Orca runs without a pane (Contracts 35.4): in the terminal's place, the worker's transcript read through
// its Dispatch, polled every 2 s while the item is open and only from the last cursor on; input goes to the worker
// as a message to its Dispatch

const POLL_MS = 2000;
const CATCH_UP_MS = 50;

const time = (ms: number) => formatTime(new Date(ms).toISOString());

type ToolPart = Extract<WorkerTurn['parts'][number], { kind: 'tool' }>;

// A tool call, collapsed to its name and what it acts on; opening it shows the input and the output
function ToolCall({ part }: { part: ToolPart }) {
  return (
    <details
      className="group min-w-0 rounded border bg-background text-xs"
      data-testid="worker-tool"
    >
      <summary className="flex min-w-0 cursor-pointer items-center gap-1.5 px-2 py-1 text-muted-foreground hover:bg-muted/50">
        <Wrench className="size-3 shrink-0" aria-hidden />
        <span className="shrink-0 font-medium text-foreground">{part.name}</span>
        <span className="min-w-0 truncate font-mono">{part.summary}</span>
        {part.failed && <span className="shrink-0 text-destructive">failed</span>}
        {part.output === null && <span className="shrink-0">running…</span>}
      </summary>
      <div className="flex flex-col gap-1 border-t px-2 py-1.5">
        {part.input !== '' && (
          <pre className="max-h-48 overflow-auto font-mono break-words whitespace-pre-wrap">
            {part.input}
          </pre>
        )}
        {part.output !== null && (
          <pre
            className={cn(
              'max-h-64 overflow-auto border-t pt-1 font-mono break-words whitespace-pre-wrap',
              part.failed && 'text-destructive',
            )}
          >
            {part.output === '' ? '(no output)' : part.output}
          </pre>
        )}
      </div>
    </details>
  );
}

function Turn({ turn, continued }: { turn: WorkerTurn; continued: boolean }) {
  const texts = turn.parts.flatMap((p) => (p.kind === 'text' ? [p.text] : []));
  const tools = turn.parts.filter((p): p is ToolPart => p.kind === 'tool');
  if (turn.role === 'system') {
    return (
      <SystemLine testId="worker-system" icon={Info} tone="muted">
        {time(turn.at)} · {texts.join(' ')}
      </SystemLine>
    );
  }
  if (turn.role === 'reasoning') {
    return (
      <details className="self-start text-xs text-muted-foreground" data-testid="worker-reasoning">
        <summary className="flex cursor-pointer items-center gap-1">
          <Brain className="size-3.5" aria-hidden />
          Thinking · {time(turn.at)}
        </summary>
        <p className="mt-1 max-w-[88%] break-words whitespace-pre-wrap">{texts.join('\n')}</p>
      </details>
    );
  }
  if (turn.role === 'user') {
    return (
      <Bubble
        side="right"
        label="To the worker"
        icon={UserRound}
        meta={time(turn.at)}
        testId="worker-user"
      >
        <div className="max-h-80 overflow-y-auto rounded-lg border px-3 py-2 text-sm break-words whitespace-pre-wrap">
          {texts.join('\n')}
        </div>
      </Bubble>
    );
  }
  const content = (
    <>
      {texts.length > 0 && <AgentText text={texts.join('\n\n')} />}
      {tools.map((part, index) => (
        <ToolCall key={`${part.name}:${String(index)}`} part={part} />
      ))}
    </>
  );
  // Orca writes every tool call as a message of its own: the agent's turns in a row share the first one's header
  if (continued) {
    return (
      <div
        className="-mt-2 flex max-w-[88%] min-w-0 flex-col gap-1 self-start"
        data-testid="worker-agent"
        title={time(turn.at)}
      >
        {content}
      </div>
    );
  }
  return (
    <Bubble side="left" label="agent" icon={Bot} meta={time(turn.at)} testId="worker-agent">
      {content}
    </Bubble>
  );
}

// Whether the agent spoke in the turn before as well (its thinking counts as the agent)
const continues = (turns: WorkerTurn[], index: number) => {
  const before = turns[index - 1];
  return (
    turns[index]?.role === 'assistant' &&
    before !== undefined &&
    (before.role === 'assistant' || before.role === 'reasoning')
  );
};

// Turns read so far, in order; a turn read again (Orca completes a tool call in place) replaces the earlier copy
function merge(turns: WorkerTurn[], page: WorkerTurn[]): WorkerTurn[] {
  if (page.length === 0) return turns;
  const next = new Map(turns.map((t) => [t.id, t]));
  for (const turn of page) next.set(turn.id, turn);
  return [...next.values()].sort((a, b) => a.at - b.at);
}

export function WorkerConversation({ liveId, running }: { liveId: string; running: boolean }) {
  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  // Where the next read continues and what was read so far; each poll reads only past the cursor and merges
  const read = useRef<{ cursor: string | null; turns: WorkerTurn[] }>({ cursor: null, turns: [] });
  // react-query polls while the window is visible (refetchIntervalInBackground is off) and keeps the last result
  // and the read's error side by side
  const transcript = useQuery({
    queryKey: ['worker-transcript', liveId],
    queryFn: async () => {
      const page = await readWorker(liveId, read.current.cursor);
      read.current = { cursor: page.cursor, turns: merge(read.current.turns, page.turns) };
      return { turns: read.current.turns, status: page.status, more: page.more };
    },
    // Orca pages 50 messages at a time: while it has more, read the next page at once, then every POLL_MS
    refetchInterval: (query) => (query.state.data?.more === true ? CATCH_UP_MS : POLL_MS),
    // Every read depends on the cursor of the one before, so a failed read is retried by the next tick
    retry: false,
  });
  const turns = transcript.data?.turns ?? [];
  const status: WorkerTranscript['status'] | null = transcript.data?.status ?? null;
  const error = transcript.isError ? transcript.error.message : null;

  // New turns scroll to the bottom unless the reader has scrolled up
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || !atBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [turns.length]);

  const send = useMutation({
    mutationFn: () => sendToWorker(liveId, text.trim()),
    onSuccess: () => {
      setText('');
    },
  });
  const canSend = running && text.trim() !== '' && !send.isPending;

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col rounded-md border"
      data-testid="worker-conversation"
    >
      <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3"
        data-testid="worker-turns"
        onScroll={(event) => {
          const el = event.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {turns.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {error === null ? 'Reading the worker’s transcript…' : 'No transcript yet.'}
          </p>
        )}
        {turns.map((turn, index) => (
          <Turn key={turn.id} turn={turn} continued={continues(turns, index)} />
        ))}
      </div>
      <form
        className="flex items-end gap-2 border-t bg-muted/20 px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend) send.mutate();
        }}
      >
        <Textarea
          rows={2}
          className="min-h-0 flex-1 resize-none"
          aria-label="Message to the worker"
          placeholder={
            running
              ? 'Message to the worker (⌘↵ to send)'
              : 'The worker has ended; Orca keeps its transcript'
          }
          disabled={!running}
          value={text}
          data-testid="worker-input"
          onChange={(event) => {
            setText(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canSend) {
              event.preventDefault();
              send.mutate();
            }
          }}
        />
        <div className="flex flex-col items-end gap-1">
          <Button type="submit" size="sm" disabled={!canSend} data-testid="worker-send">
            <SendHorizontal />
            {send.isPending ? 'Sending…' : 'Send'}
          </Button>
          {status !== null && (
            <span className="text-xs text-muted-foreground" data-testid="worker-orca-status">
              Orca: {status.worker} · {status.liveness}
            </span>
          )}
        </div>
      </form>
      {(error !== null || send.isError) && (
        <p role="alert" className="border-t px-3 py-1 text-xs text-destructive">
          {send.isError ? send.error.message : error}
        </p>
      )}
      {send.data?.delivery === 'reopened' && (
        <p role="status" className="border-t px-3 py-1 text-xs text-muted-foreground">
          The worker had already finished, so Orca started a new Dispatch for this message.
        </p>
      )}
    </div>
  );
}
