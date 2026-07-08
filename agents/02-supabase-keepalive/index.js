// agents/02-supabase-keepalive/index.js
// Keeps free Supabase projects from auto-pausing (7 days of inactivity). Pings each project listed
// in the SUPABASE_PROJECTS secret and alerts on Telegram if any looks paused OR if the ping isn't
// actually registering database activity.
//
// SUPABASE_PROJECTS = JSON array of { name, url, anonKey, table }, e.g.
//   [{"name":"fleet","url":"https://xxx.supabase.co","anonKey":"...","table":"kv"},
//    {"name":"echo","url":"https://yyy.supabase.co","anonKey":"...","table":"echo_knowledge"}]
// `table` MUST be a real table in that project — the keep-alive does a SELECT on it, which is what
// forces Postgres to stay awake. (Defaults to "kv" if omitted.)
import { env } from "../../lib/env.js";
import { notifyTelegram, tgEscape } from "../../lib/notify.js";
import { setState } from "../../lib/store.js";

const projects = JSON.parse(env("SUPABASE_PROJECTS"));

async function ping(p) {
  const table = p.table || "kv";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    // A REAL table read (SELECT ... LIMIT 1) forces Postgres to wake and resets the 7-day pause
    // timer. The bare /rest/v1/ root can be served from PostgREST's schema cache WITHOUT touching the
    // database — which is why projects paused despite "OK" pings. Any response < 500 = the project is
    // up; a 2xx = the query actually ran against the DB (activity registered).
    const res = await fetch(`${p.url}/rest/v1/${encodeURIComponent(table)}?select=*&limit=1`, {
      headers: { apikey: p.anonKey, Authorization: `Bearer ${p.anonKey}` },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return { name: p.name, alive: res.status < 500, active: res.status >= 200 && res.status < 300, code: res.status, table };
  } catch (e) {
    return { name: p.name, alive: false, active: false, code: 0, error: e.name, table };
  }
}

const results = await Promise.all(projects.map(ping));
const paused = results.filter((r) => !r.alive);                    // unreachable → likely paused
const inactive = results.filter((r) => r.alive && !r.active);      // reachable but the query didn't run → NOT being kept alive

// Persist the latest status so the dashboard can show a live Supabase Keep-Alive card. Best-effort:
// a kv write failure must never break the ping itself. Writes to the MAIN fleet project's kv.
await setState("supabase:keepalive", {
  checked_at: new Date().toISOString(),
  total: results.length,
  paused: paused.length,
  inactive: inactive.length,
  projects: results.map((r) => ({ name: r.name, alive: r.alive, active: r.active, code: r.code, table: r.table })),
}).catch((e) => console.error("keepalive kv write failed (ignored):", e.message));

// DIGEST=1 -> also send a healthy "all clear" confirmation (the weekly run).
// No flag -> alert-only: stay silent unless something looks wrong (daily run).
const DIGEST = process.env.DIGEST === "1";

if (paused.length || inactive.length) {
  const lines = [];
  for (const p of paused) lines.push(`🔴 <b>${tgEscape(p.name)}</b> — unreachable (${tgEscape(String(p.code || p.error))}). Likely PAUSED → restore at supabase.com/dashboard, then this keeps it alive.`);
  for (const p of inactive) lines.push(`🟠 <b>${tgEscape(p.name)}</b> — reachable but the keep-alive query did NOT run (code ${p.code}, table "${tgEscape(p.table)}"). Set a valid <code>table</code> for this project in SUPABASE_PROJECTS so the daily ping registers real DB activity.`);
  await notifyTelegram(`⚠️ <b>Supabase keep-alive</b>\n\n${lines.join("\n\n")}`, { html: true });
} else if (DIGEST) {
  const lines = results.map((r) => `✅ <b>${tgEscape(r.name)}</b> — active (queried <code>${tgEscape(r.table)}</code>)`).join("\n");
  await notifyTelegram(`🟢 <b>Supabase weekly check</b>\n\nAll ${results.length} project(s) active — a real query ran, so the pause timer is reset.\n\n${lines}`, { html: true });
} else {
  console.log(`All ${results.length} Supabase project(s) active.`);
}
console.log(results);
