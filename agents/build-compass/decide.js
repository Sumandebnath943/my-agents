// agents/build-compass/decide.js — Build Compass DECIDER (runs weekly, day 7).
// Reads the WEEK of accumulated demand_items and weighs demand as a blend of recurrence +
// engagement (points/comments) + requirement-depth from the comments — not recurrence alone —
// then ranks your idea backlog and returns the TOP 7 scored build candidates. Stores them for the
// dashboard (Start -> Finish -> report) and emails the ranked list.
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { callLLM, parseJson } from "../../lib/llm.js";
import { notifyEmail } from "../../lib/notify.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));
const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();

const { data: raw } = await db.from("demand_items").select("*").gte("created_at", weekAgo);
if (!raw?.length) { console.log("No demand collected this week — run the collector first."); process.exit(0); }

// Rank by engagement so the highest-signal items lead, and cap the context.
const items = raw
  .map((i) => ({ src: i.source, title: i.title, body: (i.body || "").slice(0, 300), url: i.url, pts: i.points, cmts: i.num_comments, comment_insight: (i.top_comments || "").slice(0, 500) }))
  .sort((a, b) => ((b.cmts || 0) + (b.pts || 0)) - ((a.cmts || 0) + (a.pts || 0)))
  .slice(0, 160);

const { data: ideas } = await db.from("ideas").select("*").order("score", { ascending: false });

const out = await callLLM(
  `You are my build strategist. Below is a WEEK of real demand data gathered from HN, Reddit, and
Lobste.rs (posts + engagement + top comments).

Judge demand as a BLEND, not by recurrence alone:
- RECURRENCE: the same problem surfacing across many items/sources/days.
- ENGAGEMENT: points + comment counts (how much a post resonated).
- REQUIREMENT DEPTH (most important): what people ask for in the COMMENTS — specific unmet needs,
  "me too" / "I'd pay for this" intensity, and concrete requirements they describe.
Favor things a solo dev can build on free infra, and map to my backlog where it fits (else propose net-new).

Return ONLY JSON: {"builds":[{"pick":"name","score":0-100,"why":"2-3 sentences citing the demand evidence (recurrence + engagement + what commenters specifically ask for)","first_prompt":"a detailed copy-paste Claude Code kickoff prompt","evidence":{"recurrence":"e.g. 6 mentions across HN+Reddit","engagement":"e.g. ~120 pts / 80 comments","sources":["representative urls"]}}]} — exactly the TOP 7, best first.

DEMAND (this week):
${JSON.stringify(items)}

MY BACKLOG:
${JSON.stringify((ideas || []).map((i) => ({ title: i.title, spec: i.spec })))}`,
  { json: true }
);

let builds = [];
try { builds = parseJson(out).builds || []; } catch {}
builds = builds.slice(0, 7);
if (!builds.length) { console.log("Decider returned no builds."); process.exit(0); }

// Expire last week's un-actioned candidates, then store this week's Top 7 (status 'new').
try { await db.from("build_projects").update({ status: "expired", updated_at: new Date().toISOString() }).eq("status", "new"); } catch {}
for (const b of builds) {
  try {
    await db.from("build_projects").insert({ pick: b.pick, why: b.why, first_prompt: b.first_prompt, score: b.score ?? null, evidence: b.evidence || null, status: "new" });
  } catch {}
}

const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
const html = `<h3>Top 7 to build next — a week of demand, scored</h3>` + builds.map((b, i) => {
  const ev = b.evidence || {};
  const src = (ev.sources || []).slice(0, 4).map((u) => `<a href="${u}">${esc(u).slice(0, 60)}</a>`).join(" · ");
  return `<div style="margin-bottom:18px;border-left:3px solid #C6F24E;padding-left:12px">
    <h4>${i + 1}. ${esc(b.pick)} — <span style="color:#3A4A16">score ${b.score ?? "?"}</span></h4>
    <p>${esc(b.why)}</p>
    <p style="color:#666;font-size:13px">${esc(ev.recurrence || "")}${ev.engagement ? ` · ${esc(ev.engagement)}` : ""}</p>
    ${src ? `<p style="font-size:12px">${src}</p>` : ""}
    <details><summary>Claude Code kickoff prompt</summary><pre style="white-space:pre-wrap;background:#f6f6f4;padding:12px;border-radius:10px">${esc(b.first_prompt)}</pre></details>
  </div>`;
}).join("");
await notifyEmail(`🧭 Top 7 builds this week — #1: ${builds[0].pick}`, `${html}<p style="color:#888">Track these on the Migi dashboard → Build (Start → Finish → project report).</p>`);
console.log(`Decided Top ${builds.length}. #1:`, builds[0].pick);
