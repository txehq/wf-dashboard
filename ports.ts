// Server and web dev ports; set WFD_PORT and WFD_WEB_PORT to keep worktrees running in parallel apart
function portFromEnv(name: string, defaultPort: number): number {
  const raw = process.env[name];
  if (raw === undefined) return defaultPort;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer from 1 to 65535: ${raw}`);
  }
  return port;
}

export const serverPort = portFromEnv('WFD_PORT', 7317);
export const webPort = portFromEnv('WFD_WEB_PORT', 5173);
