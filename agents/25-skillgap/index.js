// agents/25-skillgap/index.js — Skill-Gap Advisor (#25).
// Monthly. Looks at what you've actually been building (last 60 days of GitHub activity) + what's
// rising in your field (Groq `groq/compound` web search), and names AT MOST TWO specific skills to
// learn next — each stored as a trackable row (skills table) so the dashboard can run them through
// Open -> Learning -> Learnt/Dismissed. It also avoids re-recommending anything already on your
// plate, so the monthly nudge never piles up. Deliberately narrow — fights overwhelm.
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { OWNER, FOCUS } from "./config.js";
import { callGroq, callLLM, parseJson } from "../../lib/llm.js";
import { notifyEmail } from "../../lib/notify.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));

// What have you actually been building? (last 60 days of public repo activity)
const since = new Date(Date.now() - 60 * 86400000);
let repos = [];
try {
  const events = await fetch(`https://api.github.com/users/${OWNER}/events/public?per_page=100`, {
    headers: { Authorization: `Bearer ${env("GH_PAT")}`, Accept: "application/vnd.github+json", "User-Agent": "migi-agents" },
  }).then((r) => r.json());
  repos = [...new Set((Array.isArray(events) ? events : [])
    .filter((e) => new Date(e.created_at) > since)
    .map((e) => e.repo?.name))].filter(Boolean).slice(0, 20);
} catch {}

// Don't re-recommend what's already open or in progress.
let onPlate = [];
try {
  const { data } = await db.from("skills").select("skill").in("status", ["open", "learning"]);
  onPlate = (data || []).map((s) => s.skill);
} catch {}

// 1) Research what's currently rising (web-search-enabled compound).
let research = "";
try {
  research = await callGroq([{ role: "user", content: `Search the web: what skills, tools, or capabilities are most in-demand and rising RIGHT NOW for someone whose focus is: ${FOCUS}? Give a concise brief of the top rising areas.` }], { model: "groq/compound" });
} catch {}

// 2) Structure into AT MOST TWO skills (routed chain, JSON). Web-search step above stays on Groq.
const out = await callLLM(
  [
    { role: "system", content: "You are a sharp, realistic mentor. Pick AT MOST TWO specific, learnable skills — one or two, never more. Be selective and concrete. Reply ONLY JSON." },
    { role: "user", content: `My focus: ${FOCUS}
Recent repos I worked on: ${repos.join(", ") || "(none detected this period)"}
What's rising now (research): ${research || "(unavailable — use your own judgment)"}
Already on my plate — DO NOT repeat these: ${onPlate.join(", ") || "(none)"}
Return {"skills":[{"skill":"short name","why":"why it matters now","how":"how it builds on what I already do","first_step":"one concrete first step","resource":"one specific course/doc/repo to start"}]} — one or two only.` },
  ],
  { json: true }
);
let skills = [];
try { skills = (parseJson(out).skills || []).slice(0, 2); } catch {}
if (!skills.length) { console.log("No new skill recommendation this month."); process.exit(0); }

for (const s of skills) {
  try { await db.from("skills").insert({ skill: s.skill, why: s.why, how: s.how, first_step: s.first_step, resource: s.resource || null }); } catch {}
}

const esc = (x) => String(x || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
const html = skills.map((s) => `
  <div style="margin-bottom:20px;border-left:3px solid #C6F24E;padding-left:12px">
    <h3>${esc(s.skill)}</h3>
    <p><b>Why now:</b> ${esc(s.why)}</p>
    <p><b>Builds on:</b> ${esc(s.how)}</p>
    <p><b>First step:</b> ${esc(s.first_step)}</p>
    ${s.resource ? `<p><b>Start here:</b> ${esc(s.resource)}</p>` : ""}
  </div>`).join("<hr>");
await notifyEmail(`🎯 Next skill${skills.length > 1 ? "s" : ""} to learn: ${skills.map((s) => s.skill).join(" · ")}`, `${html}<p style="color:#888">Track these on the Migi dashboard → Skills (Learning → Learnt).</p>`);
console.log("Recommended:", skills.map((s) => s.skill).join(", "));
