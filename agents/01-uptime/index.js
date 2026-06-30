// agents/01-uptime/index.js
import { SITES, SLOW_MS } from "./sites.js";
import { callGroq } from "../../lib/llm.js";
import { notifyTelegram } from "../../lib/notify.js";

async function check(site) {
  const start = Date.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000); // 10s hard timeout
    const res = await fetch(site.url, { signal: ctrl.signal, redirect: "follow" });
    clearTimeout(t);
    const ms = Date.now() - start;
    let status = res.ok ? "UP" : "DOWN";
    if (res.ok && ms > SLOW_MS) status = "SLOW";
    return { ...site, status, code: res.status, ms };
  } catch (e) {
    return { ...site, status: "DOWN", code: 0, ms: Date.now() - start, error: e.name };
  }
}

const results = await Promise.all(SITES.map(check));
const problems = results.filter((r) => r.status !== "UP");

// Build a digest. Only invoke the LLM if there's something to explain.
let body = results
  .map((r) => `${r.status === "UP" ? "✅" : r.status === "SLOW" ? "🟡" : "🔴"} *${r.name}* — ${r.status} (${r.code || "no response"}, ${r.ms}ms)`)
  .join("\n");

if (problems.length) {
  const explanation = await callGroq([
    { role: "system", content: "You are an SRE. In 1-2 sentences each, give the most likely cause and first thing to check. Be specific and brief." },
    { role: "user", content: `These sites have issues:\n${problems.map((p) => `- ${p.name}: ${p.status} code=${p.code} err=${p.error || "none"}`).join("\n")}` },
  ]);
  body += `\n\n*Likely causes:*\n${explanation}`;
}

const header = problems.length
  ? `🚨 *Uptime: ${problems.length} issue(s)*`
  : `✅ *Uptime: all ${results.length} sites healthy*`;

// DIGEST=1 -> always send the full report (the daily + 6-hourly runs).
// No flag -> "watch" mode: only ping when something is actually down.
const DIGEST = process.env.DIGEST === "1";
if (DIGEST || problems.length) {
  await notifyTelegram(`${header}\n\n${body}`);
}
console.log(body);
