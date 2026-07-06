// agents/10-linkedin/10a-draft.js
// LinkedIn Autopilot — generation brain. Four modes:
//   CURATE (default: cron / /linkedin / bare dispatch) — pull AI news, rank the day's TOP 7,
//     store the batch in kv, and Telegram a tap-to-pick list (+ Auto-pick / Skip). No post yet.
//   GENERATE (env NEWS_IDX = index | "auto") — take the picked news item, ground it to the REAL
//     Suman (live portfolio + recent commits), write a POV post, hashtags, safety-check, save
//     (awaiting) -> Telegram with Approve / Edit / Regenerate.
//   REGENERATE (env REGEN_ID) — redraw an existing draft on the same news with a fresh angle.
//   EDIT (env EDIT_ID + EDIT_NOTE) — revise an existing draft per the user's instructions.
// A repetition guard (last ~14 days of drafts) keeps topics + openers from repeating.
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { callGroq, geminiThenGroq, parseJson } from "../../lib/llm.js";
import { notifyTelegram, tgEscape } from "../../lib/notify.js";
import { PROFILE, profileContext } from "../../lib/profile.js";
import { fetchXml, textOf, linkHref } from "../../lib/rss.js";
import { AI_FEEDS } from "./sources.js";
import { WRITING_PLAYBOOK, VALUE_BAR } from "./voice.js";
import { trendingHashtags } from "../../lib/hashtags.js";
import { stripMarkdown } from "../../lib/email-template.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));
const OWNER = "Sumandebnath943";
const PORTFOLIO_URL = "https://sumandebnath.houseofnamus.com";
const NEWS_BATCH_KEY = "linkedin:news_batch";

// ---- guardrails shared by generation + safety ----
const GUARDRAILS = `HARD RULES (must all hold):
- Legal, authentic, professional, public-safe. First person, as me.
- NEVER include secrets, API keys, tokens, emails, phone numbers, or private URLs.
- NO politics, religion, divisive/sentiment-hurting takes, piracy, illegal or dangerous content.
- NO fabricated metrics or invented personal anecdotes. Only claim things grounded in my portfolio/commits/beliefs; otherwise write as analysis/opinion.
- At most 1 emoji, no hashtag spam, no cringe (hashtags are added separately — do not write any).
- Plain text only — NO markdown (no **, __, ##, backticks, or bullet syntax); LinkedIn shows those characters literally.`;

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

// Repetition guard — recent drafts (topics + opening lines) so we don't repeat ourselves.
async function recentPosts(days = 14) {
  try {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const { data } = await db
      .from("linkedin_posts")
      .select("headline,post,created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(20);
    return (data || []).map((r) => ({ headline: r.headline || "", opener: (r.post || "").split("\n")[0].slice(0, 120) }));
  } catch { return []; }
}
const recentBlockOf = (recents) =>
  recents.length ? recents.map((r) => `- ${r.headline || "(untitled)"} — opened: "${r.opener}"`).join("\n") : "(none yet)";

async function sendDraft(id, row) {
  const buttons = [
    [{ text: "✅ Approve", callback_data: `li:approve:${id}` }, { text: "✏️ Edit", callback_data: `li:edit:${id}` }],
    [{ text: "🔄 Regenerate", callback_data: `li:regen:${id}` }],
  ];
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

// Hashtags now come from the shared, robust engine (lib/hashtags.js) — never empty.

// Core generation — grounds a chosen news item to the real Suman and writes the post.
// regenOf: update that existing row instead of inserting. previousPost: force a new angle.
async function writePost(item, { regenOf = null, previousPost = null } = {}) {
  const [portfolio, work, recents] = await Promise.all([stripFetch(PORTFOLIO_URL), recentWork(), recentPosts()]);
  const out = await geminiThenGroq(
    `You are ghostwriting a LinkedIn post in MY voice to position me as an ${PROFILE.positioning}.
${profileContext()}

MY LIVE PORTFOLIO (source of truth for real claims):
${portfolio || "(unavailable)"}

MY RECENT WORK (commits, last 7 days):
${work || "(none notable)"}

THE NEWS I CHOSE TO POST ABOUT:
${item.headline}${item.link ? ` (${item.link})` : ""}
${item.angle ? `A possible angle: ${item.angle}` : ""}

Write a LinkedIn post reacting to THIS news with MY real angle. The news is the hook; MY insight, grounded in my work/beliefs, is the point. It MUST teach the reader one concrete, valuable thing — never just restate the news.

${WRITING_PLAYBOOK}

${GUARDRAILS}

DON'T REPEAT MYSELF — avoid the topics and opening lines of my recent posts:
${recentBlockOf(recents)}
${previousPost ? `\nTHIS IS A REGENERATION. Take a genuinely DIFFERENT angle and structure from my previous attempt below — do NOT reuse its opening line.\nPREVIOUS ATTEMPT:\n${previousPost}\n` : ""}
${VALUE_BAR}

Return ONLY JSON {"post":"the full post, formatted with real line breaks","grounding":"one line: which real project/commit/belief the personal angle draws from"}.`,
    { json: true }
  );

  let o = {};
  try { o = parseJson(out); } catch { o = {}; }
  if (!o.post) { await notifyTelegram("🤔 Couldn't draft that one — try another news item or /linkedin again.", { html: true }); return; }
  o.post = stripMarkdown(o.post); // LinkedIn renders markdown literally — keep it plain text

  const hashtags = (await trendingHashtags(item.headline || "AI", { platform: "linkedin", count: 3 })).join(" ");
  const review = await safetyReview(o.post);
  if (review.hard) { await notifyTelegram(`🛑 Draft blocked by the safety filter (${review.reasons.join(", ")}). Not sent.`, { html: true }); return; }
  const warning = review.safe ? null : review.reasons.join("; ");

  let id = regenOf;
  if (regenOf) {
    await db.from("linkedin_posts").update({ post: o.post, hashtags, grounding: o.grounding || null, status: "awaiting", warning, updated_at: new Date().toISOString() }).eq("id", regenOf);
  } else {
    const { data: inserted } = await db.from("linkedin_posts").insert({
      headline: item.headline || null, source_url: item.link || null, post: o.post, hashtags, grounding: o.grounding || null, status: "awaiting", warning,
    }).select("id").single();
    id = inserted?.id;
  }
  await sendDraft(id, { headline: item.headline, post: o.post, hashtags, grounding: o.grounding, warning });
  console.log(regenOf ? "regenerated draft" : "draft sent", "id", id);
}

// ---------------- EDIT mode ----------------
if (process.env.EDIT_ID) {
  const id = process.env.EDIT_ID;
  const note = process.env.EDIT_NOTE || "";
  const { data: row } = await db.from("linkedin_posts").select("*").eq("id", id).maybeSingle();
  if (!row) { console.log("edit: post not found", id); process.exit(0); }
  const out = await geminiThenGroq(
    `Revise my LinkedIn post per my instructions, keeping it grounded, in my voice, and within the rules.
Apply my instructions but keep the post true to the writing playbook (hook, cadence, one concrete value, punchy close).

${WRITING_PLAYBOOK}

${GUARDRAILS}

MY INSTRUCTIONS: ${note}

CURRENT POST:
${row.post}

Return ONLY JSON {"post":"revised post text, formatted with real line breaks"}.`,
    { json: true }
  );
  let revised = row.post; try { revised = stripMarkdown(parseJson(out).post || row.post); } catch {}
  const review = await safetyReview(revised);
  if (review.hard) { await notifyTelegram(`🛑 Revised draft blocked by the safety filter (${review.reasons.join(", ")}). Not sent.`, { html: true }); process.exit(0); }
  const warning = review.safe ? null : review.reasons.join("; ");
  await db.from("linkedin_posts").update({ post: revised, status: "awaiting", edit_note: note, warning, updated_at: new Date().toISOString() }).eq("id", id);
  await sendDraft(id, { ...row, post: revised, warning });
  console.log("edit: revised", id);
  process.exit(0);
}

// ---------------- REGENERATE mode ----------------
if (process.env.REGEN_ID) {
  const id = process.env.REGEN_ID;
  const { data: row } = await db.from("linkedin_posts").select("*").eq("id", id).maybeSingle();
  if (!row) { console.log("regen: post not found", id); process.exit(0); }
  await writePost({ headline: row.headline, link: row.source_url, angle: "" }, { regenOf: id, previousPost: row.post });
  process.exit(0);
}

// ---------------- GENERATE mode (a news item was picked) ----------------
if (process.env.NEWS_IDX) {
  const { data: kvb } = await db.from("kv").select("value").eq("key", NEWS_BATCH_KEY).maybeSingle();
  const batch = kvb?.value;
  if (!batch?.items?.length) { await notifyTelegram("📭 No active news list — run /linkedin to pull today's.", { html: true }); process.exit(0); }
  const wantBatch = process.env.BATCH_ID;
  if (wantBatch && batch.id && wantBatch !== batch.id) {
    await notifyTelegram("🕒 That news list is out of date. Run /linkedin for today's fresh picks.", { html: true });
    process.exit(0);
  }

  const idx = process.env.NEWS_IDX;
  let item;
  if (idx === "auto") {
    try {
      const pick = await geminiThenGroq(
        `From this shortlist of today's AI news, pick the SINGLE best one for me to post about as ${PROFILE.positioning} (audience: ${PROFILE.audience}). Consider relevance and how well it connects to my work.\n${batch.items.map((it, i) => `${i}. ${it.headline} — ${it.why || ""}`).join("\n")}\nReturn ONLY JSON {"i":<index>}.`,
        { json: true }
      );
      item = batch.items[Number(parseJson(pick).i)] || batch.items[0];
    } catch { item = batch.items[0]; }
  } else {
    item = batch.items[Number(idx)];
  }
  if (!item) { await notifyTelegram("🤔 Couldn't find that news item — run /linkedin again.", { html: true }); process.exit(0); }
  await writePost(item);
  process.exit(0);
}

// ---------------- CURATE mode (default) ----------------
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

const recents = await recentPosts();
const curated = await geminiThenGroq(
  `You are my editorial assistant. From today's AI headlines, choose the TOP 7 most worth a LinkedIn post for me — ${PROFILE.positioning} — whose audience is ${PROFILE.audience}.
Prefer substantive developments (new models, tools, agentic/AI-product shifts, notable research) over PR fluff, funding-round noise, and clickbait. Favour freshness and relevance to my work. AVOID topics I've already posted about recently.

RECENTLY POSTED (avoid repeats):
${recentBlockOf(recents)}

TODAY'S HEADLINES (choose by index):
${headlines.map((h, i) => `${i}. ${h.title}`).join("\n")}

Return ONLY JSON {"picks":[{"i":<index>,"why":"one short line: why it matters to my audience","angle":"one short line: an angle I could take, grounded in my work"}]} with 5-7 items, best first.`,
  { json: true }
);

let picks = [];
try { picks = parseJson(curated).picks || []; } catch { picks = []; }
picks = picks.filter((p) => headlines[p.i]).slice(0, 7);
if (!picks.length) { console.log("Curate: nothing worth posting today."); process.exit(0); }

const batchId = Date.now().toString(36);
const items = picks.map((p) => ({ headline: headlines[p.i].title, link: headlines[p.i].link, why: p.why || "", angle: p.angle || "" }));
await db.from("kv").upsert({ key: NEWS_BATCH_KEY, value: { id: batchId, created_at: new Date().toISOString(), items }, updated_at: new Date().toISOString() });

const list = items.map((it, i) => `<b>${i + 1}.</b> ${tgEscape(it.headline)}\n   ↳ <i>${tgEscape(it.why)}</i>`).join("\n\n");
const numberButtons = items.map((it, i) => ({ text: String(i + 1), callback_data: `li:news:${batchId}:${i}` }));
const rows = [];
for (let i = 0; i < numberButtons.length; i += 4) rows.push(numberButtons.slice(i, i + 4));
rows.push([
  { text: "🎲 Auto-pick best", callback_data: `li:news:${batchId}:auto` },
  { text: "😴 Skip today", callback_data: `li:news:${batchId}:skip` },
]);

await notifyTelegram(`🗞️ <b>Today's top AI news</b> — tap one to draft a post:\n\n${list}`, { html: true, buttons: rows });
console.log("curated", items.length, "items, batch", batchId);
process.exit(0);
