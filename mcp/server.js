// mcp/server.js
// Migi MCP server — exposes the fleet's core capabilities as Model Context Protocol tools over
// stdio, so Claude Code / Claude Desktop (and future MAS/ECHO clients) can query live fleet data
// and trigger agents through one standard interface.
//
// ZERO DEPENDENCIES by design: the MCP stdio transport is just newline-delimited JSON-RPC 2.0,
// which we speak directly. That keeps `npm ci` in the 37 agent workflows lean (no new install), in
// keeping with the fleet's vanilla-JS ethos. Run locally: `npm run mcp`.
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { env } from "../lib/env.js";
import { getState, setState } from "../lib/store.js";
import { notifyTelegram } from "../lib/notify.js";
import { profileContext } from "../lib/profile.js";
import { webSearch } from "../lib/search.js";
import { scrapeClean } from "../lib/scrape.js";

const SERVER = { name: "migi", version: "1.0.0" };
const REPO = process.env.GITHUB_REPOSITORY || "Sumandebnath943/my-agents";

let _db;
const db = () => (_db ||= createClient(env("SUPABASE_URL"), env("SUPABASE_KEY")));

// Each tool: { name, description, inputSchema (JSON Schema), handler(args) -> string }.
export const TOOLS = [
  {
    name: "kv_get",
    description: "Read a value from the fleet's Supabase key-value store (the `kv` table).",
    inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    handler: async ({ key }) => JSON.stringify(await getState(key), null, 2),
  },
  {
    name: "kv_set",
    description: "Write a value to the fleet's key-value store. `value` may be any JSON.",
    inputSchema: { type: "object", properties: { key: { type: "string" }, value: {} }, required: ["key", "value"] },
    handler: async ({ key, value }) => { await setState(key, value); return `ok: set ${key}`; },
  },
  {
    name: "supabase_query",
    description: "Read rows from a Supabase table. Optional exact-match filters, ordering, and a limit (max 200).",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string" },
        match: { type: "object", description: "column -> value exact-match filters" },
        order_by: { type: "string" },
        ascending: { type: "boolean" },
        limit: { type: "integer" },
      },
      required: ["table"],
    },
    handler: async ({ table, match = {}, order_by, ascending = false, limit = 50 }) => {
      let q = db().from(table).select("*");
      for (const [k, v] of Object.entries(match)) q = q.eq(k, v);
      if (order_by) q = q.order(order_by, { ascending });
      q = q.limit(Math.min(Number(limit) || 50, 200));
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return JSON.stringify(data, null, 2);
    },
  },
  {
    name: "profile_context",
    description: "Get Suman's profile/positioning context block (who the agents act as).",
    inputSchema: { type: "object", properties: {} },
    handler: async () => profileContext(),
  },
  {
    name: "telegram_send",
    description: "Send a plain-text message to Suman's Telegram (notifications/answers).",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    handler: async ({ text }) => { await notifyTelegram(text); return "ok: sent"; },
  },
  {
    name: "web_search",
    description: "Real-time web search (Tavily). Returns [{title,url,content}]. Empty if search is unavailable.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, max: { type: "integer" } }, required: ["query"] },
    handler: async ({ query, max = 5 }) => JSON.stringify(await webSearch(query, { max }), null, 2),
  },
  {
    name: "scrape_url",
    description: "Fetch clean, LLM-ready text for a URL (Firecrawl when available, else fetch+strip).",
    inputSchema: { type: "object", properties: { url: { type: "string" }, max: { type: "integer" } }, required: ["url"] },
    handler: async ({ url, max = 8000 }) => (await scrapeClean(url, { max })) || "(no content)",
  },
  {
    name: "github_workflow_trigger",
    description: "Manually run a fleet agent by its workflow file name (e.g. '12-briefing.yml'). Optional ref + inputs.",
    inputSchema: {
      type: "object",
      properties: { workflow: { type: "string" }, ref: { type: "string" }, inputs: { type: "object" } },
      required: ["workflow"],
    },
    handler: async ({ workflow, ref = "main", inputs = {} }) => {
      const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${workflow}/dispatches`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env("GH_PAT")}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
        body: JSON.stringify({ ref, inputs }),
      });
      if (!res.ok) throw new Error(`dispatch ${res.status}: ${await res.text()}`);
      return `ok: dispatched ${workflow} on ${ref}`;
    },
  },
];

const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// Handle one JSON-RPC message. Returns a response object for requests, or null for notifications.
export async function handleRequest(msg) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;
  const ok = (result) => (isNotification ? null : { jsonrpc: "2.0", id, result });
  const fail = (code, message) => (isNotification ? null : { jsonrpc: "2.0", id, error: { code, message } });

  try {
    if (method === "initialize") {
      return ok({ protocolVersion: params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: SERVER });
    }
    if (method === "ping") return ok({});
    if (method?.startsWith("notifications/")) return null; // initialized / cancelled / etc.
    if (method === "tools/list") {
      return ok({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    }
    if (method === "tools/call") {
      const tool = byName[params?.name];
      if (!tool) return fail(-32602, `Unknown tool: ${params?.name}`);
      try {
        const text = await tool.handler(params.arguments || {});
        return ok({ content: [{ type: "text", text: String(text) }] });
      } catch (e) {
        return ok({ content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }); // tool error, not protocol error
      }
    }
    return fail(-32601, `Method not found: ${method}`);
  } catch (e) {
    return fail(-32603, e.message);
  }
}

// stdio loop — only when run directly (so the eval can import TOOLS/handleRequest cleanly).
const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_MAIN) {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    const s = line.trim();
    if (!s) return;
    let msg;
    try { msg = JSON.parse(s); } catch { return; } // ignore non-JSON lines
    const res = await handleRequest(msg);
    if (res) process.stdout.write(JSON.stringify(res) + "\n");
  });
  process.stderr.write("migi MCP server ready (stdio)\n");
}
