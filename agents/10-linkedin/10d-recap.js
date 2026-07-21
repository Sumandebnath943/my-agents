// agents/10-linkedin/10d-recap.js — Sunday: this week's posts + likes/comments (email),
// and a persisted engagement SAMPLE for every post from the last ~45 days.
//
// Why the two different windows: the EMAIL is a weekly recap, so it still shows only this week's
// posts (unchanged). But engagement keeps accruing for days after publishing, so a number read the
// day after a post goes out is useless for judging what actually worked. Re-sampling the trailing
// 45 days each week builds the history that lets the writer eventually learn from its own winners.
// Persistence is best-effort — without the `linkedin_engagement` table the email is exactly as before.
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { notifyEmail } from "../../lib/notify.js";
import { renderEmail } from "../../lib/email-template.js";
import { openValue } from "../../lib/crypto.js";
import { LINKEDIN_API_VERSION } from "../../lib/linkedin.js";
import { urnFromPostUrl, parseEngagement, ageDays, isSampleWorthStoring } from "./engagement.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));
const SAMPLE_DAYS = Number(process.env.LINKEDIN_SAMPLE_DAYS || 45);
const now = new Date();
const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
const sampleSince = new Date(now.getTime() - SAMPLE_DAYS * 86400000).toISOString();

// One read covers both jobs: the sampling window is a superset of the email's week.
const { data: recent } = await db.from("linkedin_posts").select("*")
  .eq("status", "posted").gte("created_at", sampleSince).order("created_at", { ascending: false });
const posts = recent || [];
const thisWeek = posts.filter((p) => p.created_at >= weekAgo);

const { data: tk } = await db.from("kv").select("value").eq("key", "linkedin:token").maybeSingle();
const token = openValue(tk?.value);

async function engagement(urn) {
  if (!token?.access_token || !urn) return null;
  try {
    const r = await fetch(`https://api.linkedin.com/rest/socialActions/${encodeURIComponent(urn)}`, {
      headers: { Authorization: `Bearer ${token.access_token}`, "LinkedIn-Version": LINKEDIN_API_VERSION, "X-Restli-Protocol-Version": "2.0.0" },
    });
    if (!r.ok) return null;
    return parseEngagement(await r.json());
  } catch { return null; }
}

// Sample every post in the window once, keyed by id so the email can reuse the same reading.
const byId = new Map();
const samples = [];
for (const p of posts) {
  const urn = urnFromPostUrl(p.post_url);
  const eng = await engagement(urn);
  byId.set(p.id, eng);
  if (eng) samples.push({ post_id: p.id, post_urn: urn, likes: eng.likes, comments: eng.comments, post_age_days: ageDays(p.created_at, now) });
}

// Persist — best-effort, but NEVER silent (S13: a subsystem that degrades must say why).
const storable = samples.filter(isSampleWorthStoring);
let saved = 0, saveError = null;
if (storable.length) {
  const { error } = await db.from("linkedin_engagement").insert(storable);
  if (error) saveError = error.message || String(error);
  else saved = storable.length;
  if (saveError) console.error(`linkedin engagement: FAILED to save ${storable.length} sample(s) — ${saveError}. Has sql/linkedin_engagement.sql been run?`);
  else console.log(`linkedin engagement: saved ${saved} sample(s) across ${posts.length} post(s) in the last ${SAMPLE_DAYS}d.`);
} else {
  console.log(`linkedin engagement: nothing to save (${posts.length} post(s) in window, none returned usable counts).`);
}

// A quiet week still reports honestly, and still banks the samples above.
if (!thisWeek.length) {
  await notifyEmail("🔗 LinkedIn — a quiet week", renderEmail({
    title: "🔗 LinkedIn Weekly", kicker: "WEEKLY", accent: "#0A66C2",
    blocks: [{ type: "text", html: "No posts published this week." }],
    footer: "LinkedIn autopilot",
  }));
  console.log("linkedin recap sent: 0 posts this week");
  process.exit(0);
}

const items = [];
for (const p of thisWeek) {
  const eng = byId.get(p.id);
  items.push({
    title: p.headline || "LinkedIn post",
    note: eng ? `👍 ${eng.likes ?? "?"} likes · 💬 ${eng.comments ?? "?"} comments` : "engagement not exposed by LinkedIn's API for this post",
    link: p.post_url || undefined,
    buttonLabel: p.post_url ? "View" : undefined,
  });
}

const blocks = [{ type: "listSection", ramp: "blue", heading: `${thisWeek.length} POST${thisWeek.length > 1 ? "S" : ""} PUBLISHED`, items }];
if (saveError) blocks.push({ type: "stat", text: `⚠️ Engagement history not saved — ${saveError.slice(0, 120)}` });

const html = renderEmail({
  title: "🔗 Your LinkedIn Week",
  kicker: "WEEKLY REVIEW",
  accent: "#0A66C2",
  blocks,
  footer: "LinkedIn autopilot · likes/comments where LinkedIn exposes them",
});
await notifyEmail("🔗 Your LinkedIn week in review", html);
console.log("linkedin recap sent:", thisWeek.length);
