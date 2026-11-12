#!/usr/bin/env node
// Stand-in for the Linear MCP connection (WFD_LINEAR_MCP): an MCP stdio server that replays real Linear tool results
// recorded by scripts/record-team-fixtures.ts. Arguments: the recording file and optionally --log <file> (one JSON line
// per call, for tests to see what was read). The recording is { calls: [{ name, args, isError, text, matchName? }],
// delayMs? } and is read on every call, so a test can swap it between syncs on the same connection; delayMs makes each
// call wait that long (a page watches a sync's progress), and matchName answers any arguments of that tool (the e2e
// data, whose listing is filtered by the wall clock). A call with no recording returns an MCP error naming it
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const [recordingFile, ...rest] = process.argv.slice(2);
if (recordingFile === undefined) {
  throw new Error('Usage: linear-stand-in.mjs <recording.json> [--log <file>]');
}
const logIndex = rest.indexOf('--log');
const logFile = logIndex === -1 ? undefined : rest[logIndex + 1];

// Arguments compare with their keys in order, so the order an object was built in does not matter
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical(value[k])]),
        )
      : value;
const key = (name, args) => JSON.stringify([name, canonical(args ?? {})]);

const recording = () => {
  const { calls, delayMs = 0 } = JSON.parse(fs.readFileSync(recordingFile, 'utf8'));
  return {
    delayMs,
    calls: new Map(calls.map((c) => [c.matchName === true ? c.name : key(c.name, c.args), c])),
  };
};

const server = new Server(
  { name: 'linear-stand-in', version: '0.0.0' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [...new Set([...recording().calls.values()].map((c) => c.name))].map((name) => ({
    name,
    inputSchema: { type: 'object' },
  })),
}));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (logFile !== undefined) {
    fs.appendFileSync(
      logFile,
      `${JSON.stringify({ name: params.name, args: params.arguments })}\n`,
    );
  }
  const { delayMs, calls } = recording();
  if (delayMs > 0) await sleep(delayMs);
  const call = calls.get(key(params.name, params.arguments)) ?? calls.get(params.name);
  if (call === undefined) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `${recordingFile} has no recording of ${params.name} ${JSON.stringify(params.arguments)}`,
        },
      ],
    };
  }
  return { isError: call.isError, content: [{ type: 'text', text: call.text }] };
});
await server.connect(new StdioServerTransport());
