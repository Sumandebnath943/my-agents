# Migi MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the fleet's core
capabilities as tools, so **Claude Code / Claude Desktop** (and future MAS/ECHO clients) can query
live fleet data and trigger agents through one standard interface — instead of you writing ad-hoc
scripts each time.

**Zero dependencies.** MCP stdio is newline-delimited JSON-RPC 2.0, which `server.js` speaks
directly — nothing new is added to the agent workflows' `npm ci`.

## Tools

| Tool | What it does | Reads/Writes |
|---|---|---|
| `kv_get` / `kv_set` | Read/write the fleet's `kv` store | Supabase |
| `supabase_query` | Read any table (filters, order, limit) | Supabase (read) |
| `profile_context` | Suman's positioning/context block | local |
| `memory_remember` / `memory_recall` | Save/recall durable scoped memories (semantic) | Supabase + Gemini |
| `web_search` | Real-time web search (Tavily) | Tavily |
| `scrape_url` | Clean LLM-ready text for a URL (Firecrawl) | Firecrawl |
| `telegram_send` | Send a plain-text Telegram message | Telegram |
| `github_workflow_trigger` | Manually run an agent by workflow filename | GitHub API |

## Run it

```bash
npm run mcp
```

It reads the same env as the agents (from `.env` locally): `SUPABASE_URL`, `SUPABASE_KEY`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `GH_PAT`. Tools whose env is missing simply error when
called; the server still starts.

## Connect it to Claude Code

Add this to your Claude MCP config (e.g. `claude_desktop_config.json`, or via Claude Code's MCP
settings), then restart the client:

```json
{
  "mcpServers": {
    "migi": {
      "command": "node",
      "args": ["D:/project/agents-for-suman/mcp/server.js"]
    }
  }
}
```

Once connected, you can ask things like *"use migi to show my last 10 expenses"* (→ `supabase_query`)
or *"trigger the briefing agent"* (→ `github_workflow_trigger`).

## Safety

`telegram_send` and `github_workflow_trigger` take real actions. They act only when the connected
client calls them — there is no autonomous loop here. Keep the server local; never expose it publicly.
