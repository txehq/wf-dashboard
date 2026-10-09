import { useMutation } from '@tanstack/react-query';
import { Bot, Hand, Info, ShieldAlert, User, UserRound } from 'lucide-react';
import { useState } from 'react';
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
import { cn } from '@/lib/utils';

const time = (ms: number) => formatTime(new Date(ms).toISOString());

// 回答的值是选项 label（多选以 ", " 连接）或自由文本
function chosenLabels(question: AskQuestion, answer: string | undefined): Set<string> {
  if (answer === undefined) return new Set();
  const labels = new Set(question.options.map((o) => o.label));
  return new Set(answer.split(', ').filter((part) => labels.has(part)));
}

function QuestionCards({
  questions,
  answers,
}: {
  questions: AskQuestion[];
  answers: Record<string, string> | null;
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
            {q.multiSelect === true && <p className="text-xs text-muted-foreground">可多选</p>}
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
                <span className="text-xs text-muted-foreground">自由回答：</span>
                {freeText}
              </p>
            )}
            {answers === null && <p className="mt-2 text-xs text-muted-foreground">等待回答</p>}
          </div>
        );
      })}
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
            {time(message.createdAt)} · 发给 agent 的初始消息
          </span>
          <pre className="font-mono text-xs whitespace-pre-wrap">{message.content}</pre>
        </div>
      );
    }
    const denied = p?.kind === 'denied';
    const Icon = denied ? ShieldAlert : Info;
    return (
      <p
        data-testid="message-system"
        className={cn(
          'flex items-start gap-1.5 self-center rounded px-2 py-1 text-xs',
          denied ? 'bg-[var(--viz-status-serious)]/10' : 'text-muted-foreground',
        )}
      >
        <Icon className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>
          {time(message.createdAt)} · {message.content}
          {message.costUsd > 0 && ` · ${formatUsd(message.costUsd)}`}
        </span>
      </p>
    );
  }
  const agent = message.role === 'agent';
  const who =
    message.role === 'agent'
      ? { label: 'agent', icon: Bot }
      : message.role === 'human'
        ? { label: '人工回答', icon: Hand }
        : { label: '模拟用户', icon: UserRound };
  const Icon = who.icon;
  return (
    <div
      data-testid={`message-${message.role}`}
      className={cn('flex max-w-[88%] flex-col gap-1', agent ? 'self-start' : 'self-end')}
    >
      <span
        className={cn(
          'flex items-center gap-1 text-xs text-muted-foreground',
          !agent && 'justify-end',
        )}
      >
        <Icon className="size-3.5" aria-hidden />
        {who.label} · {time(message.createdAt)}
        {message.costUsd > 0 && ` · ${formatUsd(message.costUsd)}`}
        {p?.kind === 'reply' && p.done && ' · 判断运行可以结束'}
      </span>
      {p?.kind === 'question' ? (
        <div className="rounded-lg border bg-muted/40 p-3">
          <QuestionCards questions={p.questions} answers={answered ? {} : null} />
        </div>
      ) : p?.kind === 'answers' ? (
        <div className="rounded-lg border p-3">
          <QuestionCards questions={p.questions} answers={p.answers} />
        </div>
      ) : agent ? (
        <div className="rounded-lg border bg-muted/40 px-3 py-2">
          <MarkdownDoc content={message.content} bare />
        </div>
      ) : (
        <div
          className={cn(
            'rounded-lg px-3 py-2 text-sm whitespace-pre-wrap',
            message.role === 'human' ? 'border-2 border-foreground/60' : 'border',
          )}
        >
          {message.content}
        </div>
      )}
    </div>
  );
}

function TextReply({ runId }: { runId: string }) {
  const [text, setText] = useState('');
  const send = useMutation({
    mutationFn: () => replyRun(runId, text.trim()),
    onSuccess: () => {
      setText('');
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
        你的回答
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
          {send.isPending ? '发送中…' : '发送回答'}
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
  const send = useMutation({ mutationFn: () => answerRun(runId, answers) });
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
            其他回答
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
          {send.isPending ? '发送中…' : '提交选择'}
        </Button>
        {!complete && <span className="text-xs text-muted-foreground">每个问题都需要回答</span>}
        {send.isError && <span className="text-sm text-destructive">{send.error.message}</span>}
      </div>
    </form>
  );
}

function Takeover({ run }: { run: RunDetail }) {
  const action = useMutation({
    mutationFn: (name: 'takeover' | 'release' | 'finish') => runAction(run.id, name),
  });
  if (run.status !== 'running') {
    return (
      <p className="text-sm text-muted-foreground" data-testid="takeover-closed">
        {run.status === 'queued' || run.status === 'preparing'
          ? 'run 开始运行后可以接管对话。'
          : 'run 已不在运行，不能再回答。'}
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
          接管
        </Button>
        <span className="text-sm text-muted-foreground" data-testid="takeover-hint">
          {pending === null ? 'agent 正在工作，提问由模拟用户回答。' : '模拟用户正在回答这个提问。'}
        </span>
        <span className="w-full text-xs text-muted-foreground">
          接管后这个 run 记为"有人工干预"，此后不能撤销；对比时默认排除。
        </span>
        {action.isError && <span className="text-sm text-destructive">{action.error.message}</span>}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3" data-testid="takeover-area">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <Hand className="size-4" aria-hidden />
        你正在回答
      </p>
      {pending === null && (
        <p className="text-sm text-muted-foreground" data-testid="takeover-hint">
          agent 正在工作，有新的提问时在这里回答。
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
          交还模拟用户
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => {
            if (window.confirm('结束运行：关闭对话并进入评分。确定？')) action.mutate('finish');
          }}
        >
          结束运行
        </Button>
        <span className="text-xs text-muted-foreground">结束运行后进入评分。</span>
        {action.isError && <span className="text-sm text-destructive">{action.error.message}</span>}
      </div>
    </div>
  );
}

export function Conversation({ run }: { run: RunDetail }) {
  // agent 的 AskUserQuestion 之后有回答时，问题卡片里不再显示"等待回答"
  const answeredRequests = new Set(
    run.messages.flatMap((m) => (m.payload?.kind === 'answers' ? [m.payload.requestId] : [])),
  );
  return (
    <section className="flex flex-col gap-3 rounded-lg border" aria-labelledby="conversation-title">
      <h2 id="conversation-title" className="border-b px-4 py-2 text-sm font-medium">
        对话
      </h2>
      <div
        className="flex max-h-[640px] flex-col gap-3 overflow-y-auto px-4"
        data-testid="conversation"
      >
        {run.messages.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">还没有消息。</p>
        )}
        {run.messages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            answered={m.payload?.kind === 'question' && answeredRequests.has(m.payload.requestId)}
          />
        ))}
      </div>
      <div className="border-t bg-muted/20 px-4 py-3">
        <Takeover run={run} />
      </div>
    </section>
  );
}
