// agents/10-linkedin/10d-recap.js — Sunday: this week's posts + likes/comments (email).
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { notifyEmail } from "../../lib/notify.js";
import { renderEmail } from "../../lib/email-template.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));
const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();

const { data } = await db.from("linkedin_posts").select("*").eq("status", "posted").gte("created_at", weekAgo).order("created_at", { ascending: false });
if (!data?.length) {
  await notifyEmail("🔗 LinkedIn — a quiet week", renderEmail({ title: "🔗 LinkedIn Weekly", kicker: "WEEKLY", accent: "#0A66C2", blocks: [{ type: "text", html: "No posts published this week." }], footer: "LinkedIn autopilot" }));
  process.exit(0);
}

const { data: tk } = await db.from("kv").select("value").eq("key", "linkedin:token").maybeSingle();
const token = tk?.value;

async function engagement(urn) {
  if (!token?.access_token || !urn) return null;
  try {
    const r = await fetch(`https://api.linkedin.com/rest/socialActions/${encodeURIComponent(urn)}`, {
      headers: { Authorization: `Bearer ${token.access_token}`, "LinkedIn-Version": "202506", "X-Restli-Protocol-Version": "2.0.0" },
    });
    if (!r.ok) return null;
    const j = await r.json();
    const likes = j.likesSummary?.totalLikes ?? j.likesSummary?.aggregatedTotalLikes;
    const comments = j.commentsSummary?.aggregatedTotalComments ?? j.commentsSummary?.count;
    return { likes: likes ?? "?", comments: comments ?? "?" };
  } catch { return null; }
}

const items = [];
for (const p of data) {
  const urn = p.post_url?.split("/update/")[1];
  const eng = await engagement(urn);
  items.push({
    title: p.headline || "LinkedIn post",
    note: eng ? `👍 ${eng.likes} likes · 💬 ${eng.comments} comments` : "engagement not exposed by LinkedIn's API for this post",
    link: p.post_url || undefined,
    buttonLabel: p.post_url ? "View" : undefined,
  });
}

const html = renderEmail({
  title: "🔗 Your LinkedIn Week",
  kicker: "WEEKLY REVIEW",
  accent: "#0A66C2",
  blocks: [{ type: "listSection", ramp: "blue", heading: `${data.length} POST${data.length > 1 ? "S" : ""} PUBLISHED`, items }],
  footer: "LinkedIn autopilot · likes/comments where LinkedIn exposes them",
});
await notifyEmail("🔗 Your LinkedIn week in review", html);
console.log("linkedin recap sent:", data.length);
