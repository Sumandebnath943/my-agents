// agents/01-uptime/index.js
import { SITES, SLOW_MS } from "./sites.js";
import { callLLM } from "../../lib/llm.js";
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

// CORRELATED-FAILURE DETECTION.
// On 2026-08-28 this agent reported 7 sites DOWN with code 0. All 7 were fine — verified from a
// second network and by the very next run 10 minutes later. GitHub's runner had briefly lost
// reach. Seven independent websites do not fail in the same second; a network fault does.
//
// So: when failures cluster, say "couldn't reach" instead of "is DOWN". The alert ALWAYS still
// fires — nothing is suppressed, and a real outage is never delayed. Only the wording changes,
// because "6 of 7 failures share one domain" is genuinely different information from "6 separate
// sites died", and it points at the right thing to check first.
const regDomain = (u) => { try { return new URL(u).hostname.split(".").slice(-2).join("."); } catch { return null; } };
const downs = results.filter((r) => r.status === "DOWN");
const unreachable = downs.filter((r) => r.code === 0);   // no response at all, vs a real 4xx/5xx

// Signal 1 — breadth: several at once, and a meaningful share of everything monitored.
const broad = unreachable.length >= 4 && unreachable.length >= results.length * 0.25;
// Signal 2 — clustering: every failure sits on ONE domain while some other domain is fine.
const failDomains = new Set(unreachable.map((r) => regDomain(r.url)).filter(Boolean));
const okOtherDomain = results.some((r) => r.status === "UP" && !failDomains.has(regDomain(r.url)));
const clustered = unreachable.length >= 3 && failDomains.size === 1 && okOtherDomain;
const correlated = unreachable.length > 0 && (broad || clustered);
const sharedDomain = failDomains.size === 1 ? [...failDomains][0] : null;

// Build a digest. Only invoke the LLM if there's something to explain.
// Each row carries a link so a suspect site is one tap away.
let body = results
  .map((r) => {
    const icon = r.status === "UP" ? "✅" : r.status === "SLOW" ? "🟡" : "🔴";
    const link = r.url ? ` · <a href="${tgEscape(r.url)}">open</a>` : "";
    return `${icon} <b>${tgEscape(r.name)}</b> — ${r.status} (${r.code || "no response"}, ${r.ms}ms)${link}`;
  })
  .join("\n");

if (correlated) {
  body += `\n\n<b>⚠️ Likely a checker-network issue, not ${unreachable.length} outages.</b>\n`
    + (clustered
        ? `All ${unreachable.length} unreachable sites are on <b>${tgEscape(sharedDomain)}</b>, while other domains responded normally. Either that host is refusing this checker, or it is genuinely down — check ${tgEscape(sharedDomain)} from your own browser first.`
        : `${unreachable.length} of ${results.length} sites returned no response at once. Simultaneous failures across unrelated hosts usually mean the checker lost network, not that every site died. Confirm from your own browser before acting.`);
}

if (problems.length) {
  const explanation = await callLLM([
    { role: "system", content: "You are an SRE. In 1-2 sentences each, give the most likely cause and first thing to check. Be specific and brief." },
    // Hand the correlation to the model too, or it will confidently diagnose N separate outages
    // and contradict the deterministic note directly above it.
    { role: "user", content: `These sites have issues:\n${problems.map((p) => `- ${p.name}: ${p.status} code=${p.code} err=${p.error || "none"}`).join("\n")}`
      + (correlated
          ? `\n\nIMPORTANT CONTEXT: these failures are CORRELATED${sharedDomain ? ` (all on ${sharedDomain})` : ""} and returned no response at all, while other sites responded normally in the same run. A network fault at the checker, or one host refusing the checker, is more likely than ${unreachable.length} independent outages. Weight your answer accordingly and do NOT assert the sites are definitely down.`
          : "") },
  ]);
  body += `\n\n<b>Likely causes:</b>\n${tgEscape(explanation)}`;
}

// A correlated blip gets a calmer siren than a genuine multi-site outage — same alert, honest
// framing, so a false alarm never reads as a catastrophe.
const header = problems.length
  ? (correlated
      ? `⚠️ <b>Uptime: can't reach ${unreachable.length} site(s)</b>`
      : `🚨 <b>Uptime: ${problems.length} issue(s)</b>`)
  : `✅ <b>Uptime: all ${results.length} sites healthy</b>`;

// DIGEST=1 -> always send the full report (the daily + 6-hourly runs).
// No flag -> "watch" mode: only ping when something is actually down.
const DIGEST = process.env.DIGEST === "1";
if (DIGEST || problems.length) {
  await notifyTelegram(`${header}\n\n${body}`, { html: true });
}
console.log(body);
