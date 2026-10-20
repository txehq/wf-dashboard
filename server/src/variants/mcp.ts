import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { HttpError } from './errors.js';

// variant 的 src/mcp.json（Contracts 28.1）：Claude Code 的 .mcp.json 格式 { "mcpServers": { … } }
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

// src/mcp.json 中的服务器；没有这个文件时为空
export function readMcpServers(src: string): Record<string, McpServer> {
  const file = path.join(src, MCP_FILE);
  if (!fs.existsSync(file)) return {};
  const parsed = McpFile.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!parsed.success) {
    throw new HttpError(
      400,
      `${file} 不符合 .mcp.json 的格式 { "mcpServers": { … } }：\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data.mcpServers;
}

// 写进 Codex 的 config.toml 的 mcp_servers：stdio 为 command、args、env，http 为 url 与 http_headers；
// Codex 不支持 sse 传输
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
          `src/mcp.json 中的 ${name} 是 sse 传输，Codex 不支持；改用 http（streamable HTTP）或 stdio`,
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
