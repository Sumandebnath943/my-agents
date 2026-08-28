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

// WHY ENGAGEMENT IS (ALMOST CERTAINLY) EMPTY, and why that is not a bug:
// this app's OAuth scope is `openid profile w_member_social` — WRITE-only. Reading likes and
// comments needs partner-tier access LinkedIn does not grant ordinary apps, so socialActions
// answers 403 for every post. Permanent platform limit, not a fault.
//
// The trap this replaces: the old code did `if (!r.ok) return null`, throwing the status away.
// A permanent 403 and an EXPIRED TOKEN (401) then produced the identical sentence in the email,
// so a real breakage was indistinguishable from the known limitation. Tally the reasons instead
// and say which one it was — once, at the bottom, rather than on every post.
const blockers = new Map();
const note = (k) => blockers.set(k, (blockers.get(k) || 0) + 1);

async function engagement(urn) {
  if (!token?.access_token) { note("no-token"); return null; }
  if (!urn) { note("no-urn"); return null; }
  try {
    const r = await fetch(`https://api.linkedin.com/rest/socialActions/${encodeURIComponent(urn)}`, {
      headers: { Authorization: `Bearer ${token.access_token}`, "LinkedIn-Version": LINKEDIN_API_VERSION, "X-Restli-Protocol-Version": "2.0.0" },
    });
    if (!r.ok) { note(String(r.status)); return null; }
    return parseEngagement(await r.json());
  } catch { note("network"); return null; }
}

// The single most common blocker, phrased for a human. Returns null when nothing was blocked.
function blockerExplanation() {
  if (!blockers.size) return null;
  const [top, n] = [...blockers.entries()].sort((a, b) => b[1] - a[1])[0];
  const suffix = ` (${n} post${n > 1 ? "s" : ""})`;
  if (top === "403") return `ℹ️ Likes/comments aren't shown because LinkedIn only shares them with partner-tier apps. This app can post, but not read engagement — a permanent LinkedIn limit, not a fault.${suffix}`;
  if (top === "401") return `⚠️ Your LinkedIn sign-in has EXPIRED — reconnect LinkedIn on the dashboard to resume posting and engagement reads.${suffix}`;
  if (top === "404") return `⚠️ LinkedIn couldn't find these posts (404) — the stored post links may be malformed.${suffix}`;
  if (top === "429") return `⚠️ LinkedIn rate-limited the engagement reads (429) — it should recover on its own.${suffix}`;
  if (top === "no-token") return `⚠️ No LinkedIn account is connected — connect it on the dashboard.${suffix}`;
  if (top === "no-urn") return `⚠️ Some posts have no usable LinkedIn link stored, so engagement can't be looked up.${suffix}`;
  if (top === "network") return `⚠️ Couldn't reach LinkedIn to read engagement.${suffix}`;
  return `ℹ️ LinkedIn returned ${top} for the engagement lookup.${suffix}`;
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
// Always print WHY, so a permanent 403 never again looks the same as an expired token in the logs.
if (blockers.size) console.log("linkedin engagement blockers:", JSON.stringify(Object.fromEntries(blockers)));

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
    note: eng ? `👍 ${eng.likes ?? "?"} likes · 💬 ${eng.comments ?? "?"} comments` : "likes/comments unavailable — see note below",
    link: p.post_url || undefined,
    buttonLabel: p.post_url ? "View" : undefined,
  });
}

const blocks = [{ type: "listSection", ramp: "blue", heading: `${thisWeek.length} POST${thisWeek.length > 1 ? "S" : ""} PUBLISHED`, items }];
// Explain the missing numbers ONCE, and say which cause it actually was.
const why = blockerExplanation();
if (why) blocks.push({ type: "stat", text: why });
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
