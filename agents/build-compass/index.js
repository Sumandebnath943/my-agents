// agents/build-compass/index.js — Build Compass (#42 × #43).
// DEMAND RADAR: reads real problems people ask to have solved (Ask HN + demand-phrase HN
// searches + Lobste.rs — all datacenter-reliable, no auth) -> DECIDER: ranks YOUR idea backlog
// (#18 ideas table) against that demand and picks ONE thing to build next, with a copy-paste
// Claude Code prompt -> stores the pick (for the dashboard) + emails the call.
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { subredditNew } from "../../lib/reddit.js";
import { callGemini, parseJson } from "../../lib/llm.js";
import { notifyEmail } from "../../lib/notify.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));

// --- reliable demand sources (Reddit is IP-blocked from datacenters, so we don't use it here) ---
async function hn(tags, query, n = 30) {
  const p = new URLSearchParams({ hitsPerPage: String(n) });
  if (tags) p.set("tags", tags);
  if (query) p.set("query", query);
  const r = await fetch(`https://hn.algolia.com/api/v1/search_by_date?${p}`).then((x) => x.json()).catch(() => ({ hits: [] }));
  return (r.hits || []).map((h) => ({ title: h.title || h.story_title || "", text: "", url: `https://news.ycombinator.com/item?id=${h.objectID}`, source: "HN" }));
}

let posts = [];
posts.push(...(await hn("ask_hn", null, 40)));                                   // people asking for tools/help
posts.push(...(await hn("show_hn", null, 20)));                                  // what's being built (adjacent)
posts.push(...(await hn(null, "looking for a tool", 15)));
posts.push(...(await hn(null, "is there a tool", 15)));
posts.push(...(await hn(null, "recommend a tool", 15)));
try {
  const lob = await fetch("https://lobste.rs/newest.json", { headers: { "User-Agent": "migi-agents/1.0" } }).then((r) => r.json());
  posts.push(...(Array.isArray(lob) ? lob : []).slice(0, 40).map((p) => ({ title: p.title || "", text: (p.description || "").slice(0, 300), url: p.short_id_url || p.url || "", source: "Lobsters" })));
} catch {}

// Reddit — the rawest demand signal. No-ops until REDDIT_CLIENT_ID/SECRET are set (see lib/reddit.js).
const SUBS = ["SaaS", "webdev", "SideProject", "indiehackers", "automation", "Entrepreneur", "startups", "nocode"];
for (const s of SUBS) {
  try { posts.push(...(await subredditNew(s, 25)).map((p) => ({ ...p, source: `r/${s}` }))); } catch {}
}

posts = posts.filter((p) => p.title);
if (!posts.length) { console.log("No demand posts fetched."); process.exit(0); }

const radar = await callGemini(
  `From these posts, extract recurring PROBLEMS people want solved (not features, not
rants). Return JSON {"signals":[{"problem":"","score":1-10 for how often+urgently it
recurs,"url":"a representative link"}]}. Keep the top 8.\n\n${JSON.stringify(posts.slice(0, 90))}`,
  { json: true }
);
let signals = [];
try { signals = parseJson(radar).signals || []; } catch {}
for (const s of signals) { try { await db.from("demand_signals").insert({ problem: s.problem, source: "radar", url: s.url, score: s.score }); } catch {} }

// 2) DECIDER: rank YOUR backlog against real demand, pick ONE.
const { data: ideas } = await db.from("ideas").select("*").order("score", { ascending: false });

const decision = await callGemini(
  `I'm a solo dev. Here is real market demand (scored) and my personal idea backlog.
Pick the SINGLE best thing for me to build next — favor ideas that match a high-demand
signal AND are buildable solo on free infra. Return JSON:
{"pick":"name","why":"2-3 sentences tying it to a demand signal","first_prompt":"a detailed copy-paste Claude Code prompt to start building it","runner_up":"name"}.
DEMAND:\n${JSON.stringify(signals)}\n\nMY BACKLOG:\n${JSON.stringify((ideas || []).map((i) => ({ title: i.title, spec: i.spec })))}`,
  { json: true }
);
let d = {};
try { d = parseJson(decision); } catch { console.log("Decider returned no JSON."); process.exit(0); }
if (!d.pick) { console.log("No pick."); process.exit(0); }

// Store the pick so the dashboard can track it (Start -> Finish -> project report).
try {
  await db.from("build_projects").insert({ pick: d.pick, why: d.why, first_prompt: d.first_prompt, runner_up: d.runner_up || null, signals });
} catch {}

const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
await notifyEmail(
  `🧭 Build next: ${d.pick}`,
  `<h3>Build this next: ${esc(d.pick)}</h3><p>${esc(d.why)}</p>
   <h4>First Claude Code prompt</h4><pre style="white-space:pre-wrap;background:#f6f6f4;padding:12px;border-radius:10px">${esc(d.first_prompt)}</pre>
   <p><i>Runner-up: ${esc(d.runner_up || "—")}</i></p>
   <p style="color:#888">Track this on the Migi dashboard → Build (Start → Finish → project report).</p>
   <h4>Top demand signals this week</h4><ul>${signals.map((s) => `<li>[${s.score}] ${esc(s.problem)}</li>`).join("")}</ul>`
);
console.log("Recommended:", d.pick);
