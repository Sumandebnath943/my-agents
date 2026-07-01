// agents/01-uptime/index.js
import { SITES, SLOW_MS } from "./sites.js";
import { callGroq } from "../../lib/llm.js";
import { notifyTelegram, tgEscape } from "../../lib/notify.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = "Mozilla/5.0 (compatible; MigiUptime/1.0; +https://houseofnamus.com)";

async function probe(url) {
  const start = Date.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000); // 12s hard timeout
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": UA } });
    clearTimeout(t);
    const ms = Date.now() - start;
    const reachable = res.status < 400; // 2xx/3xx (redirects, auth pages) = reachable
    const status = reachable ? (ms > SLOW_MS ? "SLOW" : "UP") : "DOWN";
    return { status, code: res.status, ms };
  } catch (e) {
    return { status: "DOWN", code: 0, ms: Date.now() - start, error: e.name };
  }
}

// Re-check once before flagging, and keep the healthier of the two — kills transient blips.
async function check(site) {
  const a = await probe(site.url);
  if (a.status === "UP") return { ...site, ...a };
  await sleep(2500);
  const b = await probe(site.url);
  const rank = { UP: 0, SLOW: 1, DOWN: 2 };
  const best = rank[b.status] <= rank[a.status] ? b : a;
  return { ...site, ...best };
}

const results = await Promise.all(SITES.map(check));
const problems = results.filter((r) => r.status !== "UP");

// Build a digest. Only invoke the LLM if there's something to explain.
let body = results
  .map((r) => `${r.status === "UP" ? "✅" : r.status === "SLOW" ? "🟡" : "🔴"} <b>${tgEscape(r.name)}</b> — ${r.status} (${r.code || "no response"}, ${r.ms}ms)`)
  .join("\n");

if (problems.length) {
  const explanation = await callGroq([
    { role: "system", content: "You are an SRE. In 1-2 sentences each, give the most likely cause and first thing to check. Be specific and brief." },
    { role: "user", content: `These sites have issues:\n${problems.map((p) => `- ${p.name}: ${p.status} code=${p.code} err=${p.error || "none"}`).join("\n")}` },
  ]);
  body += `\n\n<b>Likely causes:</b>\n${tgEscape(explanation)}`;
}

const header = problems.length
  ? `🚨 <b>Uptime: ${problems.length} issue(s)</b>`
  : `✅ <b>Uptime: all ${results.length} sites healthy</b>`;

// DIGEST=1 -> always send the full report (the daily + 6-hourly runs).
// No flag -> "watch" mode: only ping when something is actually down.
const DIGEST = process.env.DIGEST === "1";
if (DIGEST || problems.length) {
  await notifyTelegram(`${header}\n\n${body}`, { html: true });
}
console.log(body);
