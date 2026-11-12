# MCP servers

Read this when the workflow reads or writes external systems (Linear, GitHub, Notion, databases, ...).

## Workflows built with wf

The MCP servers of built-in lfg and ic are managed by wf; `src/mcp.json` has no effect on the variants they build.

## Workflows the dashboard manages

This session and the workflow's variants use the dashboard's own config directories and cannot see the MCP configuration in the user's own `~/.claude` or `~/.codex`. Write the servers the workflow uses into `src/mcp.json`; the dashboard installs it into this session (at every start and resume) and into the built variant (loaded by both Live and runs).

### 1. Find which servers this machine has

Only read these files, and leave the tokens and keys in them where they are:

- Claude Code: the top-level `mcpServers` in `~/.claude.json` (user scope) and `projects["<dir>"].mcpServers` (project scope); `.mcp.json` in the project directory.
- Codex: `[mcp_servers.<name>]` in `~/.codex/config.toml`.

```bash
jq '.mcpServers | map_values({type, command, args, url})' ~/.claude.json
grep -A4 '^\[mcp_servers\.' ~/.codex/config.toml
```

Tell what each server does from its `command`, `args` and `url` (for example, `mcp.linear.app` is Linear); when neither the name nor the address shows its purpose, ask the user. When this machine has no suitable server, tell the user what is missing and let the user configure it.

### 2. Write it into src/mcp.json

Same format as Claude Code's `.mcp.json`; list only the servers the workflow uses:

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

- Copy `command`, `args` and `url` exactly from the local configuration. Leave tokens or keys in `env` and `headers` empty (`src/` is stored in the variant's history), tell the user this server needs a key, and let the user decide how to provide it.
- Names use only letters, digits, `-` and `_`; `wf-history` is provided by the dashboard itself, so pick another name.
- Use only the `stdio` or `http` transport (Codex sessions do not support `sse`).
- In the stage skills that use it, say which tools of which server to use and why (in Claude Code the tool name is `mcp__<name>__<tool>`).

### 3. Taking effect and signing in

- After writing or changing it, ask the user to click "End process" in Live and then resume; only then do the new servers load. When the format is wrong, the resume fails with the original message; fix it and resume again.
- stdio servers going through `mcp-remote` reuse this machine's sign-in (`~/.mcp-auth`, where refreshed tokens are also written back), so neither Claude Code sessions nor variants need to sign in again; a Codex session's HOME is `home/` in the working directory, and on first start `mcp-remote` opens a browser and asks to sign in once.
- When an `http` server needs an OAuth sign-in (Claude Code shows "Needs authentication"), this machine's sign-in cannot be reused: ask the user to type `/mcp` in this terminal and sign in to that server. Codex sessions cannot reuse it either, so for such servers prefer the stdio form through `mcp-remote`.
- When sign-in fails or a key is needed, stop and tell the user; the user provides the credentials.
