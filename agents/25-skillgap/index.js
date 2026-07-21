// agents/25-skillgap/index.js — Skill-Gap Advisor (#25).
// Monthly. Looks at what you've actually been building (last 60 days of GitHub activity), what's
// rising in your field (Groq `groq/compound` web search), and — the strongest signal — the PROVEN
// gaps already sitting in the fleet DB: the roles the Job Agent scored you against, the JD keywords
// the ATS engine found missing from your resume, and the issue categories your own CTO patrol keeps
// flagging (see ./signals.js). It names AT MOST TWO specific skills to
// learn next — each stored as a trackable row (skills table) so the dashboard can run them through
// Open -> Learning -> Learnt/Dismissed. It also avoids re-recommending anything already on your
// plate, so the monthly nudge never piles up. Deliberately narrow — fights overwhelm.
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { OWNER, FOCUS } from "./config.js";
import { callGroq, callLLM, parseJson } from "../../lib/llm.js";
import { notifyEmail } from "../../lib/notify.js";
import { summarizeJobs, topMissingKeywords, topIssueCategories } from "./signals.js";

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

// --- Real gap signals from the rest of the fleet -------------------------------------------------
// The strongest evidence of what to learn is already in the DB and used to be ignored: the roles the
// Job Agent scored you against, the exact JD keywords the ATS engine found missing from your resume,
// and the issue categories your own CTO patrol keeps flagging. Each read is INDEPENDENTLY
// best-effort — a missing table, an empty result, or a permission error just drops that one line
// from the prompt, so the monthly run degrades to its old behaviour instead of failing.
const q = async (fn, fb) => { try { return await fn(); } catch { return fb; } };
const d90 = new Date(Date.now() - 90 * 86400000).toISOString();

// 1) Where real job matching is weakest (lowest fit first).
const jobs = await q(async () => (await db.from("jobs").select("title,company,fit,status")
  .gte("created_at", d90).order("fit", { ascending: true }).limit(60)).data || [], []);
const jobSignal = summarizeJobs(jobs);

// 2) Exact JD keywords the ATS engine found missing, counted across recent resume reports.
const reports = await q(async () => (await db.from("resume_reports").select("categories")
  .order("created_at", { ascending: false }).limit(5)).data || [], []);
const topMissing = topMissingKeywords(reports);

// 3) What my own code reviews keep flagging, aggregated by issue category.
const reviews = await q(async () => (await db.from("code_reviews").select("issues")
  .gte("created_at", d90).limit(60)).data || [], []);
const topCats = topIssueCategories(reviews);

// 1) Research what's currently rising (web-search-enabled compound).
let research = "";
try {
  research = await callGroq([{ role: "user", content: `Search the web: what skills, tools, or capabilities are most in-demand and rising RIGHT NOW for someone whose focus is: ${FOCUS}? Give a concise brief of the top rising areas.` }], { model: "groq/compound" });
} catch {}

// 2) Structure into AT MOST TWO skills (routed chain, JSON). Web-search step above stays on Groq.
const out = await callLLM(
  [
    { role: "system", content: "You are a sharp, realistic mentor. Pick AT MOST TWO specific, learnable skills — one or two, never more. Be selective and concrete. Weight the MY EVIDENCE section far above general market trends: a gap proven by my own job matches, resume keywords, or code reviews beats a trending topic I have no signal on. If the evidence and the trends disagree, follow the evidence and say so in 'why'. Reply ONLY JSON." },
    { role: "user", content: `My focus: ${FOCUS}
Recent repos I worked on: ${repos.join(", ") || "(none detected this period)"}
What's rising now (research): ${research || "(unavailable — use your own judgment)"}

MY EVIDENCE (from my own fleet data — prefer this over trends):
- Roles I'm actually scored against: ${jobSignal || "(no scored roles yet)"}
- Keywords my resume keeps MISSING vs real job descriptions: ${topMissing.join(", ") || "(no resume analysis yet)"}
- Issue categories my own code reviews keep flagging: ${topCats.join(", ") || "(none)"}

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
