// evals/mcp/run.mjs
// Guards the MCP server's protocol handling + tool registry. Offline: exercises the JSON-RPC
// dispatcher (initialize / tools/list / errors / notifications) without ever calling a tool handler,
// so no DB/network. Catches protocol regressions before a client (Claude Code) ever connects.
import "../_env.mjs";
import { runCases, isMain } from "../_lib.mjs";
import { TOOLS, handleRequest } from "../../mcp/server.js";

export async function run() {
  const init = await handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
  const list = await handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const unknownTool = await handleRequest({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope", arguments: {} } });
  const notif = await handleRequest({ jsonrpc: "2.0", method: "notifications/initialized" });
  const badMethod = await handleRequest({ jsonrpc: "2.0", id: 4, method: "foo/bar" });
  const ping = await handleRequest({ jsonrpc: "2.0", id: 5, method: "ping" });

  const cases = [
    { id: "initialize-serverInfo", ok: init?.result?.serverInfo?.name === "migi" && !!init.result.capabilities?.tools },
    { id: "tools-list-count", ok: Array.isArray(list?.result?.tools) && list.result.tools.length === TOOLS.length },
    { id: "tools-have-valid-schema", ok: list.result.tools.every((t) => t.name && t.description && t.inputSchema?.type === "object") },
    { id: "unknown-tool-invalid-params", ok: unknownTool?.error?.code === -32602 },
    { id: "notification-gets-no-response", ok: notif === null },
    { id: "unknown-method-not-found", ok: badMethod?.error?.code === -32601 },
    { id: "ping-ok", ok: ping?.result && Object.keys(ping.result).length === 0 },
  ];

  return [runCases("mcp · protocol + tool registry", cases, (c) => ({ ok: c.ok }))];
}

if (isMain(import.meta.url)) {
  const results = await run();
  process.exit(results.some((r) => r.fail) ? 1 : 0);
}
