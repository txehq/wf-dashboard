import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  AlertTriangle,
  Bot,
  ChevronRight,
  LoaderCircle,
  MessageSquare,
  Wrench,
  Zap,
} from 'lucide-react';
import { createContext, use, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  formatCount,
  formatDuration,
  formatInteger,
  formatNoun,
  formatTime,
  formatUsd,
} from '@/lib/format';
import {
  requestsQuery,
  type MessageItem,
  type RequestItem,
  type RequestRange,
  type SubagentInfo,
  type TimelineItem,
  type ToolCall,
} from '@/lib/sessions-api';

// Expand state lives outside the list: rows unmounted by virtual scrolling look the same when they return
interface ExpandState {
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
  open: (key: string) => void;
}

const ExpandContext = createContext<ExpandState | null>(null);

function useExpand(): ExpandState {
  const value = use(ExpandContext);
  if (value === null) throw new Error('ExpandContext is not provided');
  return value;
}

function useExpandState(): ExpandState {
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(new Set());
  return useMemo(
    () => ({
      isOpen: (key) => openKeys.has(key),
      toggle: (key) => {
        setOpenKeys((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      },
      open: (key) => {
        setOpenKeys((prev) => new Set(prev).add(key));
      },
    }),
    [openKeys],
  );
}

const SubagentsContext = createContext<ReadonlyMap<string, SubagentInfo>>(new Map());

// The request focused from outside (message id); that row gets a ring
const FocusContext = createContext<string | null>(null);

// A main-session request to focus from outside; nonce lets the same request be focused again.
// With toolCallId null it only scrolls to the request (jump from a conversation entry)
export interface TimelineFocus {
  seq: number;
  toolCallId: string | null;
  nonce: number;
}

function str(input: unknown, key: string): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

// Tool input summary: the most telling field for common tools, the start of the JSON otherwise
function inputSummary(call: ToolCall): string {
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = str(call.input, key);
      if (value !== null) return value;
    }
    return null;
  };
  let summary: string | null;
  switch (call.name) {
    case 'Bash':
      summary = pick('command');
      break;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      summary = pick('file_path', 'notebook_path');
      break;
    case 'Grep':
    case 'Glob':
      summary = [pick('pattern'), pick('path')].filter((v) => v !== null).join('  ');
      break;
    case 'Skill': {
      const args = pick('args');
      summary = `${pick('skill') ?? ''}${args === null ? '' : ` ${args}`}`;
      break;
    }
    case 'Agent':
    case 'Task':
      summary = pick('description', 'prompt');
      break;
    case 'WebFetch':
      summary = pick('url');
      break;
    case 'WebSearch':
      summary = pick('query');
      break;
    default:
      summary = null;
  }
  const text = summary ?? JSON.stringify(call.input);
  return text.replace(/\s+/g, ' ').slice(0, 200);
}

function Clamped({
  text,
  lines,
  expandKey,
  className,
}: {
  text: string;
  lines: number;
  expandKey: string;
  className?: string;
}) {
  const expand = useExpand();
  const open = expand.isOpen(expandKey);
  const long = text.split('\n').length > lines || text.length > lines * 110;
  return (
    <div className="flex flex-col items-start gap-0.5">
      <p
        className={`text-sm break-words whitespace-pre-wrap ${className ?? ''}`}
        style={
          open || !long
            ? undefined
            : {
                WebkitLineClamp: lines,
                display: '-webkit-box',
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }
        }
      >
        {text}
      </p>
      {long && (
        <button
          type="button"
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => {
            expand.toggle(expandKey);
          }}
        >
          {open ? 'Collapse' : 'Show all'}
        </button>
      )}
    </div>
  );
}

function ToolCallView({ call, sessionId }: { call: ToolCall; sessionId: string }) {
  const expand = useExpand();
  const subagents = use(SubagentsContext);
  const toolKey = `tool:${call.id}`;
  const agentKey = `agent:${call.id}`;
  const open = expand.isOpen(toolKey);
  const agentOpen = expand.isOpen(agentKey);
  const truncated = call.result !== null && call.resultChars > call.result.length;
  const sub = call.subagentId === null ? undefined : subagents.get(call.subagentId);
  return (
    <li className="rounded-md border bg-background" data-testid="tool-call">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
        onClick={() => {
          expand.toggle(toolKey);
        }}
      >
        <ChevronRight
          className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <Wrench className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="shrink-0 font-mono text-xs font-semibold">{call.name}</span>
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
          {inputSummary(call)}
        </span>
        {call.isError && (
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-destructive/40 px-1.5 text-xs text-destructive">
            <AlertTriangle className="size-3" aria-hidden />
            Error
          </span>
        )}
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t px-2.5 py-2" data-testid="tool-call-detail">
          <section>
            <h4 className="mb-1 text-xs font-medium text-muted-foreground">Input</h4>
            <pre className="max-h-72 overflow-auto rounded bg-muted/50 p-2 font-mono text-xs break-words whitespace-pre-wrap">
              {JSON.stringify(call.input, null, 2)}
            </pre>
          </section>
          <section>
            <h4 className="mb-1 text-xs font-medium text-muted-foreground">
              Result · {formatNoun(call.resultChars, 'character')}
            </h4>
            {call.result === null ? (
              <p className="text-xs text-muted-foreground">No result returned.</p>
            ) : (
              <pre className="max-h-96 overflow-auto rounded bg-muted/50 p-2 font-mono text-xs break-words whitespace-pre-wrap">
                {call.result}
              </pre>
            )}
            {truncated && (
              <p className="mt-1 text-xs text-muted-foreground">
                Showing the first {formatInteger(call.result?.length ?? 0)} of{' '}
                {formatInteger(call.resultChars)} characters.
              </p>
            )}
            {call.spillPath !== null && (
              <p className="mt-1 text-xs break-all text-muted-foreground">
                Full output saved at <span className="font-mono">{call.spillPath}</span>
              </p>
            )}
          </section>
        </div>
      )}
      {call.subagentId !== null && (
        <div className="border-t px-2.5 py-1.5">
          <button
            type="button"
            aria-expanded={agentOpen}
            data-testid="subagent-toggle"
            className="flex items-center gap-1.5 text-xs font-medium"
            onClick={() => {
              expand.toggle(agentKey);
            }}
          >
            <ChevronRight
              className={`size-3.5 text-muted-foreground transition-transform ${agentOpen ? 'rotate-90' : ''}`}
            />
            <Bot className="size-3.5 text-muted-foreground" aria-hidden />
            Subagent {sub?.agentType ?? call.subagentId}
            {sub !== undefined && (
              <span className="font-normal text-muted-foreground">
                · {formatNoun(sub.requestCount, 'request')}
              </span>
            )}
          </button>
          {agentOpen && (
            <div
              className="mt-1.5 border-l-2 border-[var(--viz-series-1)] pl-2"
              data-testid="subagent-rows"
            >
              <Timeline sessionId={sessionId} range={{ agent: call.subagentId }} nested />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function RequestRow({ item, sessionId }: { item: RequestItem; sessionId: string }) {
  const expand = useExpand();
  const focused = use(FocusContext) === item.messageId;
  const thinkingKey = `thinking:${item.messageId}`;
  const t = item.tokens;
  return (
    <article
      className={`flex flex-col gap-1.5 rounded-lg border bg-card px-3 py-2 ${focused ? 'ring-2 ring-foreground' : ''}`}
      data-testid="request-row"
      data-focused={focused}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
        <span className="inline-flex items-center gap-1 font-medium text-foreground">
          <Zap className="size-3.5" aria-hidden />#{item.seq}
        </span>
        <span>{formatTime(item.timestamp)}</span>
        <span className="font-mono">{item.model}</span>
        <span>
          {item.durationMs === null ? 'Duration —' : `Duration ${formatDuration(item.durationMs)}`}
        </span>
        <span
          title={`input ${formatInteger(t.input)} · output ${formatInteger(t.output)} · cache read ${formatInteger(t.cacheRead)} · cache write ${formatInteger(t.cacheCreation)}`}
        >
          in {formatCount(t.input)} · out {formatCount(t.output)} · cache read{' '}
          {formatCount(t.cacheRead)} write {formatCount(t.cacheCreation)}
        </span>
        <span className="font-medium text-foreground">{formatUsd(item.costUsd)}</span>
        {item.attributionSkill !== null && (
          <span className="rounded border px-1.5 font-mono">{item.attributionSkill}</span>
        )}
      </header>
      {item.thinking !== null && item.thinking !== '' && (
        <div>
          <button
            type="button"
            aria-expanded={expand.isOpen(thinkingKey)}
            className="flex items-center gap-1 text-xs text-muted-foreground"
            onClick={() => {
              expand.toggle(thinkingKey);
            }}
          >
            <ChevronRight
              className={`size-3.5 transition-transform ${expand.isOpen(thinkingKey) ? 'rotate-90' : ''}`}
            />
            Thinking · {formatInteger(item.thinking.length)}{' '}
            {item.thinking.length === 1 ? 'character' : 'characters'}
          </button>
          {expand.isOpen(thinkingKey) && (
            <p className="mt-1 border-l-2 pl-2 text-xs break-words whitespace-pre-wrap text-muted-foreground italic">
              {item.thinking}
            </p>
          )}
        </div>
      )}
      {item.text !== null && item.text !== '' && (
        <Clamped text={item.text} lines={4} expandKey={`text:${item.messageId}`} />
      )}
      {item.toolCalls.length > 0 && (
        <ul className="flex flex-col gap-1">
          {item.toolCalls.map((call) => (
            <ToolCallView key={call.id} call={call} sessionId={sessionId} />
          ))}
        </ul>
      )}
    </article>
  );
}

function MessageRow({ item, index }: { item: MessageItem; index: number }) {
  if (item.kind === 'user') {
    return (
      <article
        className="flex flex-col gap-1 rounded-lg border border-[var(--viz-series-1)]/40 bg-[var(--viz-series-1)]/5 px-3 py-2"
        data-testid="user-row"
      >
        <header className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
          <MessageSquare className="size-3.5" aria-hidden />
          <span className="font-medium text-foreground">User</span>
          <span>{formatTime(item.timestamp)}</span>
        </header>
        <Clamped text={item.text} lines={6} expandKey={`user:${item.timestamp}:${String(index)}`} />
      </article>
    );
  }
  return (
    <article
      className="flex items-start gap-2 rounded-md border border-dashed px-3 py-1.5 text-xs text-muted-foreground"
      data-testid="notice-row"
    >
      <span className="shrink-0 font-medium">System event</span>
      <span className="shrink-0 tabular-nums">{formatTime(item.timestamp)}</span>
      <Clamped
        text={item.text}
        lines={2}
        expandKey={`notice:${item.timestamp}:${String(index)}`}
        className="text-xs"
      />
    </article>
  );
}

function itemKey(item: TimelineItem, index: number): string {
  return item.kind === 'request'
    ? item.messageId
    : `${item.kind}:${item.timestamp}:${String(index)}`;
}

type ScrollHandle = RefObject<((index: number) => void) | null>;

function VirtualRows({
  items,
  sessionId,
  nested,
  scrollHandle,
  follow = false,
}: {
  items: TimelineItem[];
  sessionId: string;
  nested: boolean;
  scrollHandle?: ScrollHandle | undefined;
  // Live run: stay on the latest row; stops jumping once the user scrolls up, resumes back at the bottom
  follow?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 110,
    overscan: 6,
    getItemKey: (index) => {
      const item = items[index];
      return item === undefined ? index : itemKey(item, index);
    },
  });
  useEffect(() => {
    if (scrollHandle === undefined) return;
    scrollHandle.current = (index) => {
      virtualizer.scrollToIndex(index, { align: 'start' });
    };
    return () => {
      scrollHandle.current = null;
    };
  }, [virtualizer, scrollHandle]);
  const following = follow && atBottom;
  const total = virtualizer.getTotalSize();
  // Follow the latest: scroll to the bottom when rows are added or the last request grows (height changes)
  useEffect(() => {
    if (following && items.length > 0) {
      virtualizer.scrollToIndex(items.length - 1, { align: 'end' });
    }
  }, [following, items.length, total, virtualizer]);
  return (
    <div className="relative">
      <div
        ref={scrollRef}
        className="overflow-y-auto overscroll-contain"
        style={nested ? { height: Math.min(total, 560) } : { height: '72vh' }}
        data-testid={nested ? 'nested-timeline' : 'timeline'}
        data-following={follow ? following : undefined}
        data-count={items.length}
        onScroll={
          follow
            ? (event) => {
                const el = event.currentTarget;
                setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
              }
            : undefined
        }
      >
        <div className="relative w-full" style={{ height: total }}>
          {virtualizer.getVirtualItems().map((row) => {
            const item = items[row.index];
            if (item === undefined) return null;
            return (
              <div
                key={row.key}
                ref={virtualizer.measureElement}
                data-index={row.index}
                className="absolute top-0 left-0 w-full pb-2"
                style={{ transform: `translateY(${String(row.start)}px)` }}
              >
                {item.kind === 'request' ? (
                  <RequestRow item={item} sessionId={sessionId} />
                ) : (
                  <MessageRow item={item} index={row.index} />
                )}
              </div>
            );
          })}
        </div>
      </div>
      {follow && !atBottom && (
        <button
          type="button"
          className="absolute right-4 bottom-4 rounded-full border bg-background px-3 py-1 text-xs shadow-sm hover:bg-muted"
          onClick={() => {
            setAtBottom(true);
          }}
        >
          Jump to latest
        </button>
      )}
    </div>
  );
}

function Timeline({
  sessionId,
  range,
  nested,
  scrollHandle,
  follow = false,
}: {
  sessionId: string;
  range: RequestRange;
  nested: boolean;
  scrollHandle?: ScrollHandle;
  follow?: boolean;
}) {
  const query = useQuery(requestsQuery(sessionId, range));
  if (query.isPending)
    return (
      <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" />
        Loading requests…
      </p>
    );
  // When a background refetch fails, data is still there: show it as usual with the error above, keeping
  // scroll position and expand state
  const items = query.data;
  if (items === undefined)
    return (
      <p role="alert" className="py-6 text-sm text-destructive">
        Failed to load requests: {query.error.message}
      </p>
    );
  const refreshError = query.isError ? (
    <p role="alert" className="text-sm text-destructive">
      Failed to refresh requests: {query.error.message}
    </p>
  ) : null;
  if (items.length === 0)
    return (
      <>
        {refreshError}
        <p className="py-6 text-sm text-muted-foreground">No requests in this part.</p>
      </>
    );
  return (
    <>
      {refreshError}
      <VirtualRows
        items={items}
        sessionId={sessionId}
        nested={nested}
        scrollHandle={scrollHandle}
        follow={follow}
      />
    </>
  );
}

// Requests: a range of main-session requests (or all of them), with user messages and system events
// interleaved by time
export function RequestTimeline({
  sessionId,
  range,
  subagents,
  follow = false,
  focus = null,
}: {
  sessionId: string;
  range: RequestRange;
  subagents: SubagentInfo[];
  follow?: boolean;
  focus?: TimelineFocus | null;
}) {
  const expand = useExpandState();
  const subagentMap = useMemo(() => new Map(subagents.map((s) => [s.agentId, s])), [subagents]);
  const query = useQuery(requestsQuery(sessionId, range));
  const scrollRef = useRef<((index: number) => void) | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Focus: scroll to the request and expand its tool call; if the call is inside a subagent, expand the
  // subagents that request started. open changes with the expand state, so it sits in a ref and focusing
  // runs only when focus or data change
  const openRef = useRef(expand.open);
  useEffect(() => {
    openRef.current = expand.open;
  });
  useEffect(() => {
    if (focus === null || query.data === undefined) return;
    const index = query.data.findIndex((i) => i.kind === 'request' && i.seq === focus.seq);
    const item = query.data[index];
    if (item?.kind !== 'request') return;
    if (focus.toolCallId !== null) {
      const call = item.toolCalls.find((c) => c.id === focus.toolCallId);
      if (call === undefined) {
        for (const c of item.toolCalls) if (c.subagentId !== null) openRef.current(`agent:${c.id}`);
      } else {
        openRef.current(`tool:${call.id}`);
      }
    }
    scrollRef.current?.(index);
    // The virtual list renders the row one frame after scrolling: wait for it, then scroll it and the page to
    // the center. When the page opens already focused (?seq=), the list has just mounted and is not measured,
    // so the first scroll has no effect; scroll again while the row has not appeared
    let frames = 0;
    let handle = 0;
    const reveal = () => {
      const row = rootRef.current?.querySelector('[data-focused="true"]');
      if (row !== null && row !== undefined) {
        row.scrollIntoView({ block: 'center' });
        return;
      }
      scrollRef.current?.(index);
      frames += 1;
      if (frames < 30) handle = requestAnimationFrame(reveal);
    };
    handle = requestAnimationFrame(reveal);
    return () => {
      cancelAnimationFrame(handle);
    };
  }, [focus, query.data]);
  const focusedId = useMemo(() => {
    if (focus === null) return null;
    const item = query.data?.find((i) => i.kind === 'request' && i.seq === focus.seq);
    return item?.kind === 'request' ? item.messageId : null;
  }, [focus, query.data]);

  const counts = useMemo(() => {
    const items = query.data ?? [];
    const agents: { index: number; call: ToolCall }[] = [];
    let requests = 0;
    let users = 0;
    items.forEach((item, index) => {
      if (item.kind === 'request') {
        requests += 1;
        for (const call of item.toolCalls)
          if (call.subagentId !== null) agents.push({ index, call });
      } else if (item.kind === 'user') users += 1;
    });
    return { requests, users, agents };
  }, [query.data]);

  return (
    <ExpandContext value={expand}>
      <SubagentsContext value={subagentMap}>
        <div ref={rootRef} className="flex min-w-0 flex-col gap-2">
          {query.data !== undefined && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>
                {formatNoun(counts.requests, 'request')} ·{' '}
                {formatNoun(counts.users, 'user message')}
              </span>
              {counts.agents.map(({ index, call }) => {
                const sub = call.subagentId === null ? undefined : subagentMap.get(call.subagentId);
                return (
                  <button
                    key={call.id}
                    type="button"
                    data-testid="subagent-jump"
                    className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 hover:bg-muted"
                    onClick={() => {
                      expand.open(`agent:${call.id}`);
                      scrollRef.current?.(index);
                    }}
                  >
                    <Bot className="size-3" aria-hidden />
                    {sub?.description ?? inputSummary(call)}
                  </button>
                );
              })}
            </div>
          )}
          <FocusContext value={focusedId}>
            <Timeline
              sessionId={sessionId}
              range={range}
              nested={false}
              scrollHandle={scrollRef}
              follow={follow}
            />
          </FocusContext>
        </div>
      </SubagentsContext>
    </ExpandContext>
  );
}
