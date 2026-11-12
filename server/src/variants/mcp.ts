import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { HttpError } from './errors.js';

// The variant's src/mcp.json (Contracts 28.1): Claude Code's .mcp.json format { "mcpServers": { ... } }
const StdioServer = z.looseObject({
  type: z.literal('stdio').optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});
const RemoteServer = z.looseObject({
  type: z.enum(['http', 'sse']),
  url: z.url(),
  headers: z.record(z.string(), z.string()).optional(),
});
const McpServer = z.union([StdioServer, RemoteServer]);
export type McpServer = z.infer<typeof McpServer>;
const McpFile = z.object({
  mcpServers: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), McpServer),
});

export const MCP_FILE = 'mcp.json';

// Servers in src/mcp.json; empty when the file does not exist
export function readMcpServers(src: string): Record<string, McpServer> {
  const file = path.join(src, MCP_FILE);
  if (!fs.existsSync(file)) return {};
  const parsed = McpFile.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!parsed.success) {
    throw new HttpError(
      400,
      `${file} does not match the .mcp.json format { "mcpServers": { ... } }:\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data.mcpServers;
}

// mcp_servers for Codex's config.toml: command, args, env for stdio; url and http_headers for http;
// Codex does not support the sse transport
export function codexMcpServers(servers: Record<string, McpServer>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]): [string, unknown] => {
      if (!('url' in server)) {
        return [
          name,
          {
            command: server.command,
            ...(server.args === undefined ? {} : { args: server.args }),
            ...(server.env === undefined ? {} : { env: server.env }),
          },
        ];
      }
      if (server.type === 'sse') {
        throw new HttpError(
          400,
          `${name} in src/mcp.json uses the sse transport, which Codex does not support; use http (streamable HTTP) or stdio`,
        );
      }
      return [
        name,
        {
          url: server.url,
          ...(server.headers === undefined ? {} : { http_headers: server.headers }),
        },
      ];
    }),
  );
}
