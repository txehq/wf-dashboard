// 服务端与 web dev 端口；多个 worktree 并行运行时用 WFD_PORT、WFD_WEB_PORT 错开
function portFromEnv(name: string, defaultPort: number): number {
  const raw = process.env[name];
  if (raw === undefined) return defaultPort;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} 必须是 1 到 65535 的整数：${raw}`);
  }
  return port;
}

export const serverPort = portFromEnv('WFD_PORT', 7317);
export const webPort = portFromEnv('WFD_WEB_PORT', 5173);
