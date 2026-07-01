// agents/10-linkedin/10a-draft.js
// Draft-only, NEWS-REACTIVE: pull today's AI news, pick the most relevant item, and
// write a LinkedIn thought-leadership post wrapping YOUR experience + beliefs + voice
// around it. Emails you the draft and saves it to a queue. (Never auto-posts.)
import { callGemini, parseJson } from "../../lib/llm.js";
import { notifyEmail } from "../../lib/notify.js";
import { renderEmail } from "../../lib/email-template.js";
import { getState, setState } from "../../lib/store.js";
import { PROFILE, profileContext } from "../../lib/profile.js";
import { fetchXml, textOf, linkHref } from "../../lib/rss.js";
import { AI_FEEDS } from "./sources.js";

async function readFeed(url) {
  try {
    const feed = await fetchXml(url);
    const items = feed?.rss?.channel?.item || feed?.feed?.entry || [];
    const arr = Array.isArray(items) ? items : [items];
    return arr.slice(0, 12).map((it) => ({ title: textOf(it.title), link: linkHref(it.link) }));
  } catch (e) {
    console.error(`feed failed: ${url}`, e.message);
    return [];
  }
}

const raw = (await Promise.all(AI_FEEDS.map(readFeed))).flat().filter((a) => a.title);
const seen = new Set();
const headlines = raw.filter((a) => { const k = a.title.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 40);
if (!headlines.length) { console.log("No headlines fetched."); process.exit(0); }

const out = await callGemini(
  `You are ghostwriting a LinkedIn post for me, positioning me as an ${PROFILE.positioning}.
${profileContext()}

From today's AI headlines below, pick the SINGLE most relevant and timely one for my pillars and audience.
Write ONE LinkedIn post (120-200 words) that:
- opens with a specific hook about that development (no "in today's fast-paced world" fluff),
- gives MY distinct point of view, weaving in my experience/beliefs where it fits naturally (don't force all of them),
- ends with a sharp takeaway or a genuine question.
Write as me, first person. No hashtag spam, minimal emoji, no buzzwords, no cringe.
Return ONLY JSON: {"headline":"the one you picked","link":"its url","post":"the full post text"}.

Today's AI headlines:
${headlines.map((h) => `- ${h.title} (${h.link})`).join("\n")}`,
  { json: true }
);

let o = {};
try { o = parseJson(out); } catch { o = {}; }
const post = o.post || "";
if (!post) { console.log("No post produced."); process.exit(0); }

const queue = (await getState("linkedin:queue", [])) || [];
const id = Date.now();
queue.push({ id, text: post, source: o.link || null, headline: o.headline || null, status: "pending", created_at: new Date().toISOString() });
await setState("linkedin:queue", queue);

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const blocks = [];
if (o.headline) blocks.push({ type: "hero", ramp: "blue", kicker: "REACTING TO", title: o.headline, link: o.link || undefined, buttonLabel: o.link ? "📰 Read the source" : undefined });
blocks.push({ type: "text", html: esc(post).replace(/\n/g, "<br>") });

const html = renderEmail({
  title: "📝 Your LinkedIn Draft",
  kicker: "THOUGHT LEADERSHIP",
  accent: "#185FA5",
  blocks,
  footer: "Copy-paste to LinkedIn when you like it · saved to your /drafts queue",
});
await notifyEmail("📝 Your LinkedIn draft is ready", html);
console.log(post);
