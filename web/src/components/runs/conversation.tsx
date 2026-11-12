import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Hand, Info, type LucideIcon, ShieldAlert, User, UserRound } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { MarkdownDoc } from '@/components/markdown-doc';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { formatTime, formatUsd } from '@/lib/format';
import {
  answerRun,
  type AskQuestion,
  type Pending,
  replyRun,
  runAction,
  type RunDetail,
  type RunMessage,
} from '@/lib/runs-api';
import { type ConversationItem, conversationQuery } from '@/lib/sessions-api';
import { cn } from '@/lib/utils';

const time = (ms: number) => formatTime(new Date(ms).toISOString());

// An answer is the option label (multi-select joined with ", ") or free text
function chosenLabels(question: AskQuestion, answer: string | undefined): Set<string> {
  if (answer === undefined) return new Set();
  const labels = new Set(question.options.map((o) => o.label));
  return new Set(answer.split(', ').filter((part) => labels.has(part)));
}

function QuestionCards({
  questions,
  answers,
  unansweredLabel = 'Waiting for answer',
}: {
  questions: AskQuestion[];
  answers: Record<string, string> | null;
  // Shown when answers is null: "Waiting for answer" in a live run, "No answer" in a session record
  unansweredLabel?: string;
}) {
  return (
    <div className="flex flex-col gap-2" data-testid="question-cards">
      {questions.map((q) => {
        const answer = answers?.[q.question];
        const chosen = chosenLabels(q, answer);
        const freeText = answer !== undefined && chosen.size === 0 ? answer : null;
        return (
          <div key={q.question} className="rounded-md border bg-background p-3">
            {q.header !== undefined && <p className="text-xs text-muted-foreground">{q.header}</p>}
            <p className="text-sm font-medium">{q.question}</p>
            {q.multiSelect === true && (
              <p className="text-xs text-muted-foreground">Select one or more</p>
            )}
            <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
              {q.options.map((o) => {
                const picked = chosen.has(o.label);
                return (
                  <li
                    key={o.label}
                    data-picked={picked}
                    className={cn(
                      'rounded border px-2 py-1.5 text-sm',
                      picked && 'border-2 border-foreground bg-muted font-medium',
                    )}
                  >
                    {picked && <span className="mr-1">✓</span>}
                    {o.label}
                    {o.description !== undefined && (
                      <span className="block text-xs font-normal text-muted-foreground">
                        {o.description}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {freeText !== null && (
              <p className="mt-2 text-sm">
                <span className="text-xs text-muted-foreground">Free answer: </span>
                {freeText}
              </p>
            )}
            {answers === null && (
              <p className="mt-2 text-xs text-muted-foreground">{unansweredLabel}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

// One message: agent on the left, the answering side on the right; with onJump, clicking jumps to the request in Requests
export function Bubble({
  side,
  label,
  icon: Icon,
  meta,
  testId,
  seq,
  onJump,
  children,
}: {
  side: 'left' | 'right';
  label: string;
  icon: LucideIcon;
  meta: string;
  testId: string;
  seq?: number | null;
  onJump?: (() => void) | undefined;
  children: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'flex max-w-[88%] min-w-0 flex-col gap-1',
        side === 'left' ? 'self-start' : 'self-end',
      )}
    >
      <span
        className={cn(
          'flex items-center gap-1 text-xs text-muted-foreground',
          side === 'right' && 'justify-end',
        )}
      >
        <Icon className="size-3.5" aria-hidden />
        {label} · {meta}
        {onJump !== undefined && seq !== null && seq !== undefined && (
          <JumpButton seq={seq} onJump={onJump} />
        )}
      </span>
      {children}
    </div>
  );
}

function JumpButton({ seq, onJump }: { seq: number; onJump: () => void }) {
  return (
    <button
      type="button"
      data-testid="conversation-jump"
      className="ml-1 rounded border px-1 font-mono hover:bg-muted"
      title="Show in Requests"
      onClick={onJump}
    >
      #{seq}
    </button>
  );
}

export function SystemLine({
  testId,
  icon: Icon,
  tone,
  children,
}: {
  testId: string;
  icon: LucideIcon;
  tone: 'muted' | 'serious';
  children: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'flex max-w-full min-w-0 items-start gap-1.5 self-center rounded px-2 py-1 text-xs',
        tone === 'serious' ? 'bg-[var(--viz-status-serious)]/10' : 'text-muted-foreground',
      )}
    >
      <Icon className="mt-px size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

export function AgentText({ text }: { text: string }) {
  return (
    <div className="min-w-0 rounded-lg border bg-muted/40 px-3 py-2">
      <MarkdownDoc content={text} bare />
    </div>
  );
}

function MessageBubble({ message, answered }: { message: RunMessage; answered: boolean }) {
  const p = message.payload;
  if (message.role === 'system') {
    if (p?.kind === 'initial') {
      return (
        <div
          className="flex flex-col gap-1 rounded-md border border-dashed px-3 py-2"
          data-testid="message-initial"
        >
          <span className="text-xs text-muted-foreground">
            {time(message.createdAt)} · Initial message to the agent
          </span>
          <pre className="font-mono text-xs break-words whitespace-pre-wrap">{message.content}</pre>
        </div>
      );
    }
    const denied = p?.kind === 'denied';
    return (
      <SystemLine
        testId="message-system"
        icon={denied ? ShieldAlert : Info}
        tone={denied ? 'serious' : 'muted'}
      >
        {time(message.createdAt)} · {message.content}
        {message.costUsd > 0 && ` · ${formatUsd(message.costUsd)}`}
      </SystemLine>
    );
  }
  const agent = message.role === 'agent';
  const who =
    message.role === 'agent'
      ? { label: 'agent', icon: Bot }
      : message.role === 'human'
        ? { label: 'Human answer', icon: Hand }
        : { label: 'Simulated user', icon: UserRound };
  const meta = [
    time(message.createdAt),
    message.costUsd > 0 ? formatUsd(message.costUsd) : null,
    p?.kind === 'reply' && p.done ? 'Judged the run can end' : null,
  ]
    .filter((part) => part !== null)
    .join(' · ');
  return (
    <Bubble
      side={agent ? 'left' : 'right'}
      label={who.label}
      icon={who.icon}
      meta={meta}
      testId={`message-${message.role}`}
    >
      {p?.kind === 'question' ? (
        <div className="rounded-lg border bg-muted/40 p-3">
          <QuestionCards questions={p.questions} answers={answered ? {} : null} />
        </div>
      ) : p?.kind === 'answers' ? (
        <div className="rounded-lg border p-3">
          <QuestionCards questions={p.questions} answers={p.answers} />
        </div>
      ) : agent ? (
        <AgentText text={message.content} />
      ) : (
        <div
          className={cn(
            'rounded-lg px-3 py-2 text-sm break-words whitespace-pre-wrap',
            message.role === 'human' ? 'border-2 border-foreground/60' : 'border',
          )}
        >
          {message.content}
        </div>
      )}
    </Bubble>
  );
}

function TextReply({ runId }: { runId: string }) {
  const [text, setText] = useState('');
  const refresh = useRefreshRun(runId);
  const send = useMutation({
    mutationFn: () => replyRun(runId, text.trim()),
    onSuccess: async () => {
      setText('');
      await refresh();
    },
  });
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        send.mutate();
      }}
    >
      <label className="text-sm font-medium" htmlFor="human-reply">
        Your answer
      </label>
      <Textarea
        id="human-reply"
        rows={4}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={text.trim() === '' || send.isPending}>
          {send.isPending ? 'Sending…' : 'Send answer'}
        </Button>
        {send.isError && <span className="text-sm text-destructive">{send.error.message}</span>}
      </div>
    </form>
  );
}

function QuestionReply({
  runId,
  pending,
}: {
  runId: string;
  pending: Extract<Pending, { kind: 'questions' }>;
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const answers: Record<string, string> = {};
  for (const q of pending.questions) {
    const free = other[q.question]?.trim() ?? '';
    const labels = picked[q.question] ?? [];
    if (free !== '') answers[q.question] = free;
    else if (labels.length > 0) answers[q.question] = labels.join(', ');
  }
  const complete = pending.questions.every((q) => answers[q.question] !== undefined);
  const refresh = useRefreshRun(runId);
  const send = useMutation({ mutationFn: () => answerRun(runId, answers), onSuccess: refresh });
  return (
    <form
      className="flex flex-col gap-3"
      data-testid="question-reply"
      onSubmit={(event) => {
        event.preventDefault();
        send.mutate();
      }}
    >
      {pending.questions.map((q) => (
        <fieldset key={q.question} className="flex flex-col gap-1.5 rounded-md border p-3">
          <legend className="px-1 text-sm font-medium">{q.question}</legend>
          {q.options.map((o) => {
            const list = picked[q.question] ?? [];
            return (
              <label key={o.label} className="flex items-start gap-2 text-sm">
                <input
                  type={q.multiSelect === true ? 'checkbox' : 'radio'}
                  name={q.question}
                  className="mt-1"
                  checked={list.includes(o.label)}
                  onChange={() => {
                    const next =
                      q.multiSelect === true
                        ? list.includes(o.label)
                          ? list.filter((l) => l !== o.label)
                          : [...list, o.label]
                        : [o.label];
                    setPicked({ ...picked, [q.question]: next });
                  }}
                />
                <span>
                  {o.label}
                  {o.description !== undefined && (
                    <span className="block text-xs text-muted-foreground">{o.description}</span>
                  )}
                </span>
              </label>
            );
          })}
          <label className="flex items-center gap-2 text-sm">
            Other answer
            <input
              className="h-8 flex-1 rounded-md border bg-background px-2"
              value={other[q.question] ?? ''}
              onChange={(event) => {
                setOther({ ...other, [q.question]: event.target.value });
              }}
            />
          </label>
        </fieldset>
      ))}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={!complete || send.isPending}>
          {send.isPending ? 'Sending…' : 'Submit answers'}
        </Button>
        {!complete && <span className="text-xs text-muted-foreground">Answer every question</span>}
        {send.isError && <span className="text-sm text-destructive">{send.error.message}</span>}
      </div>
    </form>
  );
}

// After an action succeeds, wait for the run detail to refetch: buttons stay disabled until the new state appears, so double clicks send no second request
function useRefreshRun(runId: string) {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: ['runs', 'detail', runId] });
}

function Takeover({ run }: { run: RunDetail }) {
  const refresh = useRefreshRun(run.id);
  const action = useMutation({
    mutationFn: (name: 'takeover' | 'release' | 'finish') => runAction(run.id, name),
    onSuccess: refresh,
  });
  if (run.status !== 'running') {
    return (
      <p className="text-sm text-muted-foreground" data-testid="takeover-closed">
        {run.status === 'queued' || run.status === 'preparing'
          ? 'You can take over the conversation once the run starts.'
          : 'The run is no longer running and cannot be answered.'}
      </p>
    );
  }
  const pending = run.pending;
  const busy = action.isPending;
  if (run.mode === 'simulated') {
    return (
      <div className="flex flex-wrap items-center gap-3" data-testid="takeover-area">
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            action.mutate('takeover');
          }}
        >
          <User />
          Take over
        </Button>
        <span className="text-sm text-muted-foreground" data-testid="takeover-hint">
          {pending === null
            ? 'The agent is working. The simulated user answers its questions.'
            : 'The simulated user is answering this question.'}
        </span>
        <span className="w-full text-xs text-muted-foreground">
          Taking over marks this run as human-intervened, permanently. Compare excludes it by
          default.
        </span>
        {action.isError && <span className="text-sm text-destructive">{action.error.message}</span>}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3" data-testid="takeover-area">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <Hand className="size-4" aria-hidden />
        You are answering
      </p>
      {pending === null && (
        <p className="text-sm text-muted-foreground" data-testid="takeover-hint">
          The agent is working. Answer here when it asks something.
        </p>
      )}
      {pending?.kind === 'text' && <TextReply key={pending.since} runId={run.id} />}
      {pending?.kind === 'questions' && (
        <QuestionReply key={pending.requestId} runId={run.id} pending={pending} />
      )}
      <div className="flex flex-wrap items-center gap-2 border-t pt-3">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => {
            action.mutate('release');
          }}
        >
          Hand back to simulated user
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => {
            if (window.confirm('End the run? The conversation closes and grading starts.'))
              action.mutate('finish');
          }}
        >
          End run
        </Button>
        <span className="text-xs text-muted-foreground">Grading starts when the run ends.</span>
        {action.isError && <span className="text-sm text-destructive">{action.error.message}</span>}
      </div>
    </div>
  );
}

// Conversation frame shared by Runs and Sessions detail. With follow, new messages scroll to the bottom;
// scrolling up stops following, scrolling back to the bottom resumes it
function ConversationPanel({
  empty,
  footer,
  description,
  follow = null,
  children,
}: {
  empty: boolean;
  footer?: ReactNode;
  description?: ReactNode;
  // Message count when following; scrolls to the bottom when it grows
  follow?: number | null;
  children: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (follow === null || el === null || !atBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [follow]);
  return (
    <section
      className="flex min-w-0 flex-col gap-3 rounded-lg border"
      aria-labelledby="conversation-title"
    >
      <h2
        id="conversation-title"
        className="flex flex-wrap items-baseline gap-2 border-b px-4 py-2 text-sm font-medium"
      >
        Conversation
        {description !== undefined && (
          <span className="text-xs font-normal text-muted-foreground">{description}</span>
        )}
      </h2>
      <div
        ref={scrollRef}
        className="flex max-h-[640px] min-w-0 flex-col gap-3 overflow-y-auto px-4 pb-3"
        data-testid="conversation"
        onScroll={(event) => {
          const el = event.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {empty && (
          <p className="py-6 text-center text-sm text-muted-foreground">No messages yet.</p>
        )}
        {children}
      </div>
      {footer !== undefined && <div className="border-t bg-muted/20 px-4 py-3">{footer}</div>}
    </section>
  );
}

export function Conversation({ run }: { run: RunDetail }) {
  // Once an agent AskUserQuestion has an answer, its card no longer shows "Waiting for answer"
  const answeredRequests = new Set(
    run.messages.flatMap((m) => (m.payload?.kind === 'answers' ? [m.payload.requestId] : [])),
  );
  return (
    <ConversationPanel
      empty={run.messages.length === 0}
      footer={<Takeover run={run} />}
      follow={run.messages.length}
    >
      {run.messages.map((m) => (
        <MessageBubble
          key={m.id}
          message={m}
          answered={m.payload?.kind === 'question' && answeredRequests.has(m.payload.requestId)}
        />
      ))}
    </ConversationPanel>
  );
}

const isoTime = (iso: string) => formatTime(iso);

function SessionItem({
  item,
  onJump,
}: {
  item: ConversationItem;
  onJump: (seq: number, toolCallId: string | null) => void;
}) {
  const jump =
    item.seq === null
      ? undefined
      : () => {
          if (item.seq !== null)
            onJump(item.seq, item.kind === 'question' ? item.toolCallId : null);
        };
  switch (item.kind) {
    case 'user':
      return (
        <Bubble
          side="right"
          label="User"
          icon={UserRound}
          meta={isoTime(item.timestamp)}
          testId="message-user"
          seq={item.seq}
          onJump={jump}
        >
          <div className="rounded-lg border px-3 py-2 text-sm break-words whitespace-pre-wrap">
            {item.text}
          </div>
        </Bubble>
      );
    case 'agent':
      return (
        <Bubble
          side="left"
          label="agent"
          icon={Bot}
          meta={isoTime(item.timestamp)}
          testId="message-agent"
          seq={item.seq}
          onJump={jump}
        >
          <AgentText text={item.text} />
        </Bubble>
      );
    case 'question':
      return (
        <Bubble
          side="left"
          label="agent question"
          icon={Bot}
          meta={`${isoTime(item.timestamp)}${item.answers === null ? ' · No answer' : ''}`}
          testId="message-question"
          seq={item.seq}
          onJump={jump}
        >
          <div className="rounded-lg border bg-muted/40 p-3">
            <QuestionCards
              questions={item.questions}
              answers={item.answers}
              unansweredLabel="No answer"
            />
          </div>
        </Bubble>
      );
    case 'notice':
      return (
        <SystemLine testId="message-notice" icon={Info} tone="muted">
          {isoTime(item.timestamp)} ·{' '}
          {item.text.length > 240 ? `${item.text.slice(0, 240)}…` : item.text}
          {item.seq !== null && jump !== undefined && <JumpButton seq={item.seq} onJump={jump} />}
        </SystemLine>
      );
  }
}

// Sessions detail: the conversation rebuilt from the session record (Contracts 11)
export function SessionConversation({
  sessionId,
  onJump,
}: {
  sessionId: string;
  onJump: (seq: number, toolCallId: string | null) => void;
}) {
  const conversation = useQuery(conversationQuery(sessionId));
  if (conversation.isPending) {
    return <p className="text-sm text-muted-foreground">Building conversation…</p>;
  }
  if (conversation.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        Could not load the conversation: {conversation.error.message}
      </p>
    );
  }
  const items = conversation.data;
  return (
    <ConversationPanel
      empty={items.length === 0}
      description="Click a # number to jump to that row in Requests"
    >
      {items.map((item, index) => (
        <SessionItem
          key={`${item.kind}:${item.timestamp}:${String(index)}`}
          item={item}
          onJump={onJump}
        />
      ))}
    </ConversationPanel>
  );
}
