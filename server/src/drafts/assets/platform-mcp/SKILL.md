---
name: platform-mcp
description: 这个 workflow 要读写外部系统（Linear、GitHub、Notion、数据库……）时用：查本机已经配好的 MCP 服务器，把需要的写进 src/mcp.json，并告诉用户怎样让它生效、要不要登录。Use when a workflow being designed needs an MCP server.
---

# platform-mcp

这个会话与 workflow 的 variant 都用 dashboard 自己的配置目录，不读用户自己的 `~/.claude`、`~/.codex`。workflow 要用的 MCP 服务器写进 `src/mcp.json`（优化会话为 `optimize/src/mcp.json`），dashboard 把它装进这个会话与构建出的 variant。

## 1. 查本机有哪些 MCP 服务器

只读，不改这些文件，不把其中的 token、key 打印出来：

- Claude Code：`~/.claude.json` 顶层的 `mcpServers`（用户范围）与 `projects["<目录>"].mcpServers`（项目范围）；项目目录中的 `.mcp.json`。
- Codex：`~/.codex/config.toml` 的 `[mcp_servers.<名字>]`。

```bash
jq '.mcpServers | map_values({type, command, args, url})' ~/.claude.json
grep -A4 '^\[mcp_servers\.' ~/.codex/config.toml
```

按 `command`、`args` 与 `url` 判断每个服务器是做什么的（例如 `mcp.linear.app` 是 Linear）。名字与地址都看不出用途时问用户。本机没有合适的服务器时告诉用户缺什么，不要自己写调用 API 的脚本代替。

## 2. 写进 src/mcp.json

格式与 Claude Code 的 `.mcp.json` 相同，只写 workflow 用到的服务器：

```json
{
  "mcpServers": {
    "linear": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.linear.app/mcp"]
    },
    "docs": { "type": "http", "url": "https://example.com/mcp" }
  }
}
```

- 从本机配置原样抄 `command`、`args`、`url`；`env` 与 `headers` 中有 token 或 key 时不要抄进来（`src/` 会被保存进 variant 的历史），告诉用户这个服务器需要密钥，由用户决定怎样提供。
- 名字只用字母、数字、`-` 与 `_`，不能叫 `wf-history`（dashboard 自己提供）。
- 传输只用 `stdio` 或 `http`：Codex 会话不支持 `sse`。
- 在用到它的阶段 skill 中写明用哪个服务器的哪些工具、为什么需要（Claude Code 中工具名为 `mcp__<名字>__<工具>`）。

## 3. 生效与登录

- 这个会话在启动与 resume 时读 `src/mcp.json`：写好或改过后请用户在 Live 中"结束进程"，再点 resume，新的服务器才会加载。格式不对时 resume 以原文失败，改好再 resume。
- 保存并构建后，variant 在 Live 与 run 中用的就是这份 `src/mcp.json`。
- 登录（dashboard 实测）：
  - 经 `mcp-remote` 的 stdio 服务器（例如上面的 `linear`）沿用本机的登录（`~/.mcp-auth`，刷新的 token 同样写回那里），Claude Code 的会话与 variant 都不用再登录。Codex 会话的 HOME 是工作目录中的 `home/`，第一次启动时 `mcp-remote` 会打开浏览器要求登录一次。
  - `http` 服务器要 OAuth 登录时（Claude Code 显示 "Needs authentication"），本机的登录不能沿用：请用户在这个终端中输入 `/mcp`，选中这个服务器登录。Codex 会话中同样不能沿用，这类服务器优先用经 `mcp-remote` 的 stdio 写法。
- 登不上或要密钥时停下来告诉用户，不要写绕过登录的脚本，也不要去读或复制用户的凭据文件。
