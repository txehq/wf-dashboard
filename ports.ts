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

// Compare 的 e2e 使用专用数据目录，另起一对服务，端口在上面两个之上加 1000
export const compareServerPort = serverPort + 1000;
export const compareWebPort = webPort + 1000;

// Runs 的 e2e 同样另起一对服务（专用数据目录，其中有导入的已结束 run），端口加 2000
export const runsServerPort = serverPort + 2000;
export const runsWebPort = webPort + 2000;

// 环境检查与 pnpm start 的 e2e：构建后由服务端一个端口提供页面与 API，端口加 3000；
// 使用手册的截图另起一个同样的服务，端口加 4000
export const environmentServerPort = serverPort + 3000;
export const guideServerPort = serverPort + 4000;

// 分析页面的 e2e：专用数据目录与来源目录，另起一对服务，端口加 5000
export const analysesServerPort = serverPort + 5000;
export const analysesWebPort = webPort + 5000;

// 交互项的关闭、删除与导入选择框的 e2e：专用数据目录与来源目录，另起一对服务，端口加 6000
export const liveItemsServerPort = serverPort + 6000;
export const liveItemsWebPort = webPort + 6000;
