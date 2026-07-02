// agents/10-linkedin/10a-draft.js
// LinkedIn Autopilot — generation brain.
// DRAFT mode (default): pull AI news -> ground to the REAL Suman (live portfolio + recent
//   commits) -> write a POV post -> research hashtags (Groq web search) -> safety-check ->
//   save to linkedin_posts (awaiting) -> Telegram with Approve/Edit buttons.
// EDIT mode (env EDIT_ID + EDIT_NOTE): revise an existing draft per the user's instructions.
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { callGemini, callGroq, parseJson } from "../../lib/llm.js";
import { notifyTelegram, tgEscape } from "../../lib/notify.js";
import { PROFILE, profileContext } from "../../lib/profile.js";
import { fetchXml, textOf, linkHref } from "../../lib/rss.js";
import { AI_FEEDS } from "./sources.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));
const OWNER = "Sumandebnath943";
const PORTFOLIO_URL = "https://sumandebnath.houseofnamus.com";

// ---- guardrails shared by generation + safety ----
const GUARDRAILS = `HARD RULES (must all hold):
- Legal, authentic, professional, public-safe. First person, as me.
- NEVER include secrets, API keys, tokens, emails, phone numbers, or private URLs.
- NO politics, religion, divisive/sentiment-hurting takes, piracy, illegal or dangerous content.
- NO fabricated metrics or invented personal anecdotes. Only claim things grounded in my portfolio/commits/beliefs; otherwise write as analysis/opinion.
- Max 3 hashtags, at most 1 emoji, ~120-200 words, no hashtag spam, no cringe.`;

// Deterministic secret/PII scan — a hard block that doesn't rely on the model.
const SECRET_RE = /(gsk_[A-Za-z0-9]{6,}|re_[A-Za-z0-9]{6,}|AIza[0-9A-Za-z_-]{10,}|sk-[A-Za-z0-9]{10,}|eyJ[A-Za-z0-9_-]{10,}|xox[baprs]-|Bearer\s+[A-Za-z0-9._-]{12,}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\b\d{10}\b|[a-z0-9]+\.supabase\.co)/i;

async function stripFetch(url) {
  try {
    const html = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.text());
    return html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 6000);
  } catch { return ""; }
}

const gh = (p) => fetch(`https://api.github.com${p}`, { headers: { Authorization: `Bearer ${env("GH_PAT")}`, Accept: "application/vnd.github+json" } }).then((r) => r.json());
async function recentWork() {
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  let out = "";
  try {
    const repos = await gh(`/user/repos?affiliation=owner&per_page=100&sort=pushed`);
    for (const r of (Array.isArray(repos) ? repos : []).slice(0, 12)) {
      const commits = await gh(`/repos/${OWNER}/${r.name}/commits?since=${since}&per_page=8`);
      const msgs = (Array.isArray(commits) ? commits : []).map((c) => c.commit.message.split("\n")[0]);
      if (msgs.length) out += `\n${r.name}: ${msgs.join("; ")}`;
    }
  } catch {}
  return out;
}

async function sendDraft(id, row) {
  const buttons = [[{ text: "✅ Approve", callback_data: `li:approve:${id}` }, { text: "✏️ Edit", callback_data: `li:edit:${id}` }]];
  const warn = row.warning ? `\n\n⚠️ <i>Safety note: ${tgEscape(row.warning)}</i>` : "";
  await notifyTelegram(
    `📝 <b>LinkedIn draft</b> <i>(id ${id})</i>${row.headline ? `\n<i>Re: ${tgEscape(row.headline)}</i>` : ""}\n\n${tgEscape(row.post)}\n\n${tgEscape(row.hashtags || "")}${row.grounding ? `\n\n<i>grounded in: ${tgEscape(row.grounding)}</i>` : ""}${warn}`,
    { html: true, buttons }
  );
}

async function safetyReview(post) {
  if (SECRET_RE.test(post)) return { safe: false, hard: true, reasons: ["possible secret/PII/contact detail detected"] };
  try {
    const out = await callGroq(
      [
        { role: "system", content: "You are a strict compliance reviewer for public LinkedIn posts. Reply ONLY JSON." },
        { role: "user", content: `Does this post contain any: secrets/PII, political/religious/divisive content, sentiment-hurting content, piracy/illegal/dangerous content, or fabricated metrics/claims? Return {"safe":true|false,"reasons":["..."]}.\n\nPOST:\n${post}` },
      ],
      { json: true }
    );
    const j = parseJson(out);
    return { safe: j.safe !== false, hard: false, reasons: j.reasons || [] };
  } catch {
    return { safe: true, hard: false, reasons: [] };
  }
}

async function researchHashtags(topic) {
  try {
    const out = await callGroq(
      [{ role: "user", content: `Search the web for 3 currently relevant, well-performing LinkedIn hashtags for a post about "${topic}" aimed at founders, AI builders, and marketers. Return ONLY the 3 hashtags, space-separated, each starting with #. No other text.` }],
      { model: "groq/compound" }
    );
    const tags = (out.match(/#[A-Za-z0-9]+/g) || []).slice(0, 3);
    return tags.join(" ");
  } catch { return ""; }
}

// ---------------- EDIT mode ----------------
if (process.env.EDIT_ID) {
  const id = process.env.EDIT_ID;
  const note = process.env.EDIT_NOTE || "";
  const { data: row } = await db.from("linkedin_posts").select("*").eq("id", id).maybeSingle();
  if (!row) { console.log("edit: post not found", id); process.exit(0); }
  const out = await callGemini(
    `Revise my LinkedIn post per my instructions, keeping it grounded and within the rules.
${GUARDRAILS}

MY INSTRUCTIONS: ${note}

CURRENT POST:
${row.post}

Return ONLY JSON {"post":"revised post text"}.`,
    { json: true }
  );
  let revised = row.post; try { revised = parseJson(out).post || row.post; } catch {}
  const review = await safetyReview(revised);
  if (review.hard) { await notifyTelegram(`🛑 Revised draft blocked by the safety filter (${review.reasons.join(", ")}). Not sent.`, { html: true }); process.exit(0); }
  const warning = review.safe ? null : review.reasons.join("; ");
  await db.from("linkedin_posts").update({ post: revised, status: "awaiting", edit_note: note, warning, updated_at: new Date().toISOString() }).eq("id", id);
  await sendDraft(id, { ...row, post: revised, warning });
  console.log("edit: revised", id);
  process.exit(0);
}

// ---------------- DRAFT mode ----------------
async function readFeed(url) {
  try {
    const feed = await fetchXml(url);
    const items = feed?.rss?.channel?.item || feed?.feed?.entry || [];
    const arr = Array.isArray(items) ? items : [items];
    return arr.slice(0, 12).map((it) => ({ title: textOf(it.title), link: linkHref(it.link) }));
  } catch { return []; }
}

const raw = (await Promise.all(AI_FEEDS.map(readFeed))).flat().filter((a) => a.title);
const seen = new Set();
const headlines = raw.filter((a) => { const k = a.title.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 40);
if (!headlines.length) { console.log("No headlines fetched."); process.exit(0); }

const [portfolio, work] = await Promise.all([stripFetch(PORTFOLIO_URL), recentWork()]);

const out = await callGemini(
  `You are ghostwriting a LinkedIn post to position me as an ${PROFILE.positioning}.
${profileContext()}

MY LIVE PORTFOLIO (source of truth for real claims):
${portfolio || "(unavailable)"}

MY RECENT WORK (commits, last 7 days):
${work || "(none notable)"}

TODAY'S AI HEADLINES:
${headlines.map((h) => `- ${h.title} (${h.link})`).join("\n")}

Pick the SINGLE most relevant, timely headline for my audience and connect it to my REAL work/POV.
${GUARDRAILS}
If nothing today is genuinely relevant or worth posting, return {"skip":true}.
Otherwise return ONLY JSON {"headline":"","link":"","post":"the full post","grounding":"one line: which real project/commit/belief the personal angle draws from"}.`,
  { json: true }
);

let o = {};
try { o = parseJson(out); } catch { o = {}; }
if (o.skip || !o.post) { console.log("Cooldown: nothing relevant enough to post today."); process.exit(0); }

const hashtags = await researchHashtags(o.headline || "AI");
const review = await safetyReview(o.post);
if (review.hard) { await notifyTelegram(`🛑 Draft blocked by the safety filter (${review.reasons.join(", ")}). Not sent.`, { html: true }); process.exit(0); }
const warning = review.safe ? null : review.reasons.join("; ");

const { data: inserted } = await db.from("linkedin_posts").insert({
  headline: o.headline || null, source_url: o.link || null, post: o.post, hashtags, grounding: o.grounding || null, status: "awaiting", warning,
}).select("id").single();

const id = inserted?.id;
await sendDraft(id, { headline: o.headline, post: o.post, hashtags, grounding: o.grounding, warning });
console.log("draft sent, id", id);
