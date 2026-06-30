// agents/02-supabase-keepalive/index.js
import { env } from "../../lib/env.js";
import { notifyTelegram } from "../../lib/notify.js";

const projects = JSON.parse(env("SUPABASE_PROJECTS"));

async function ping(p) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    // Hitting the REST root with the anon key counts as DB activity and
    // resets the 7-day pause timer. A paused project errors or times out.
    const res = await fetch(`${p.url}/rest/v1/`, {
      headers: { apikey: p.anonKey, Authorization: `Bearer ${p.anonKey}` },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return { name: p.name, ok: res.status < 500, code: res.status };
  } catch (e) {
    return { name: p.name, ok: false, code: 0, error: e.name };
  }
}

const results = await Promise.all(projects.map(ping));
const paused = results.filter((r) => !r.ok);

// DIGEST=1 -> also send a healthy "all clear" confirmation (the weekly run).
// No flag -> alert-only: stay silent unless something looks paused (daily run).
const DIGEST = process.env.DIGEST === "1";

if (paused.length) {
  const lines = paused
    .map((p) => `🔴 *${p.name}* may be PAUSED (code ${p.code}). Restore: supabase.com/dashboard`)
    .join("\n");
  await notifyTelegram(`⚠️ *Supabase alert*\n\n${lines}`);
} else if (DIGEST) {
  const lines = results.map((r) => `✅ *${r.name}* — OK (${r.code})`).join("\n");
  await notifyTelegram(
    `🟢 *Supabase weekly check*\n\nAll ${results.length} projects pinged OK.\n\n${lines}`
  );
} else {
  console.log(`All ${results.length} Supabase projects pinged OK.`);
}
console.log(results);
