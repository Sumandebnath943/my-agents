// agents/outreach-scout/index.js — Outreach Scout (#51 × #53).
// Weekly. Finds opportunities you'd never stumble on — freelance/contract gigs, build collabs /
// cofounder chats, and hackathons — from Reddit (RSS), HN's "Seeking freelancer?" thread, and
// Devpost, then Groq screens to what actually fits you and drafts a specific, warm, non-cringe
// intro for each. DRAFT-ONLY: it never sends anything to a human — you send the intro yourself.
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { subredditsNew } from "../../lib/reddit.js";
import { callGroq, parseJson } from "../../lib/llm.js";
import { notifyEmail } from "../../lib/notify.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));
const strip = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();

const ME = `Senior product marketer (9+ yrs) and AI-native builder who ships full-stack AI products solo (Next.js/FastAPI/Supabase, Claude Code). Open to: freelance/contract in AI product, marketing, GTM, or prompt/AI-workflow engineering; build collaborations and cofounder conversations; and AI hackathons. NOT interested in generic low-end dev gigs, data-entry, or unpaid "exposure".`;

// --- Sources (all datacenter-reliable) ---
// 1) Reddit opportunity subs (RSS): [Hiring]/gig posts, cofounder & collab calls.
const SUBS = ["forhire", "jobbit", "cofounder", "SideProject", "IndieDev"];
let pool = [];
try { pool.push(...(await subredditsNew(SUBS, 60))); } catch {}

// 2) HN "Freelancer? Seeking freelancer?" — the SEEKING FREELANCER comments are companies hiring freelancers.
try {
  const hits = await fetch(`https://hn.algolia.com/api/v1/search_by_date?tags=story&query=${encodeURIComponent("Seeking freelancer")}&hitsPerPage=8`).then((r) => r.json()).then((j) => j.hits || []).catch(() => []);
  const thread = hits.find((h) => /seeking freelancer/i.test(h.title || "")) || hits[0];
  if (thread) {
    const it = await fetch(`https://hn.algolia.com/api/v1/items/${thread.objectID}`).then((r) => r.json());
    pool.push(...(it.children || []).filter((c) => c.text).slice(0, 50).map((c) => ({
      title: strip(c.text).slice(0, 110), text: strip(c.text).slice(0, 700),
      url: `https://news.ycombinator.com/item?id=${c.id}`, source: "HN freelance",
    })));
  }
} catch {}

// 3) Devpost — open online hackathons.
try {
  const dp = await fetch("https://devpost.com/api/hackathons?status[]=open", { headers: { "User-Agent": "migi-agents/1.0" } }).then((r) => r.json());
  pool.push(...(dp.hackathons || []).slice(0, 20).map((h) => ({
    title: h.title || "", text: `${h.submission_period_dates || ""} · ${(h.themes || []).map((t) => t.name).join(", ")} · prizes ${h.prize_amount ? strip(h.prize_amount) : "?"}`,
    url: h.url || "", source: "Devpost",
  })));
} catch {}

// Dedupe by url and drop empties.
const seen = new Set();
pool = pool.filter((p) => p.title && p.url && !seen.has(p.url) && seen.add(p.url));
if (!pool.length) { console.log("No opportunities fetched."); process.exit(0); }

// Groq screens for genuine fit + drafts a specific intro each.
const picked = await callGroq(
  [
    { role: "system", content: `You screen opportunities for me and draft outreach. Me: ${ME}\nFrom the list, keep ONLY genuinely relevant, legitimate, paid ones. For each, return JSON {"items":[{"kind":"freelance|collab|cofounder|hackathon|bounty|grant","title":"short label","url":"","draft":"a specific, warm, non-generic 3-4 sentence intro I could send, referencing THIS specific post and tying it to my background"}]}. If nothing genuinely fits, return {"items":[]}. Never spammy, never generic, no more than 8 items.` },
    { role: "user", content: JSON.stringify(pool.slice(0, 70)) },
  ],
  { json: true }
);
let items = [];
try { items = parseJson(picked).items || []; } catch {}
if (!items.length) { console.log("No fits this week."); process.exit(0); }

// Store (draft-only, status 'new'), deduped against what we've already surfaced.
let added = 0;
for (const it of items) {
  try {
    const { data } = await db.from("opportunities").select("id").eq("url", it.url).maybeSingle();
    if (data) continue;
    await db.from("opportunities").insert({ kind: it.kind, title: it.title, url: it.url, source: "scout", draft: it.draft });
    added++;
  } catch {}
}

const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
const html = items.map((i) => `
  <div style="margin-bottom:20px;border-left:3px solid #C6F24E;padding-left:12px">
    <h4>${esc(i.kind)} — ${esc(i.title)}</h4>
    <p><a href="${i.url}">${esc(i.url).slice(0, 70)}</a></p>
    <p><b>Draft intro (you send it):</b><br>${esc(i.draft).replace(/\n/g, "<br>")}</p>
  </div>`).join("<hr>");
await notifyEmail(`🧭 ${items.length} opportunities + drafted intros`, `${html}<p style="color:#888">Draft-only — review and send yourself. Tracked on the dashboard.</p>`);
console.log(`Found ${items.length}, ${added} new.`);
