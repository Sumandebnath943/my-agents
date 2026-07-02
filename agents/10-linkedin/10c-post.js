// agents/10-linkedin/10c-post.js
// Publishes an approved LinkedIn post (env POST_ID). Reads the token from Supabase kv
// (minted by the dashboard Connect flow), refreshes it if old, posts via the Posts API,
// updates the audit row, and confirms on Telegram + email.
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { notifyEmail, notifyTelegram, tgEscape } from "../../lib/notify.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));

async function freshToken(t) {
  if (t.refresh_token && Date.now() - t.obtained > 50 * 86400000) {
    const r = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: t.refresh_token,
        client_id: env("LINKEDIN_CLIENT_ID"),
        client_secret: env("LINKEDIN_CLIENT_SECRET"),
      }),
    }).then((r) => r.json());
    if (r.access_token) {
      const updated = { ...t, access_token: r.access_token, obtained: Date.now() };
      await db.from("kv").upsert({ key: "linkedin:token", value: updated, updated_at: new Date().toISOString() });
      return updated.access_token;
    }
  }
  return t.access_token;
}

const postId = process.env.POST_ID;
if (!postId) { console.error("No POST_ID."); process.exit(1); }

const { data: row } = await db.from("linkedin_posts").select("*").eq("id", postId).maybeSingle();
if (!row) { console.error("Post not found:", postId); process.exit(1); }
if (row.status === "posted") { console.log("Already posted."); process.exit(0); }

const { data: tk } = await db.from("kv").select("value").eq("key", "linkedin:token").maybeSingle();
const token = tk?.value;
if (!token?.access_token) {
  await notifyTelegram("🔴 <b>Can't post:</b> LinkedIn isn't connected. Open the Migi dashboard → LinkedIn → Connect.", { html: true });
  process.exit(1);
}
const access = await freshToken(token);

// LinkedIn's Posts API `commentary` uses the "Little Text" format: these characters are
// reserved and MUST be backslash-escaped, otherwise LinkedIn silently DROPS everything from
// the first unescaped one onward (the "post appears half" bug). Escape the body; leave the
// appended hashtags unescaped so they stay clickable (`#Word` tokens have no reserved chars).
const escapeLI = (s) => s.replace(/[\\<>~_*#@|(){}\[\]]/g, (c) => `\\${c}`);
const commentary = (escapeLI(row.post) + (row.hashtags ? `\n\n${row.hashtags}` : "")).trim();
const res = await fetch("https://api.linkedin.com/rest/posts", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${access}`,
    "Content-Type": "application/json",
    "LinkedIn-Version": "202506",
    "X-Restli-Protocol-Version": "2.0.0",
  },
  body: JSON.stringify({
    author: token.person_urn,
    commentary,
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  }),
});

if (res.ok || res.status === 201) {
  const urn = res.headers.get("x-restli-id") || res.headers.get("x-linkedin-id") || "";
  const postUrl = urn ? `https://www.linkedin.com/feed/update/${urn}` : "";
  await db.from("linkedin_posts").update({ status: "posted", post_url: postUrl, updated_at: new Date().toISOString() }).eq("id", postId);
  await notifyTelegram(`✅ <b>Posted to LinkedIn</b>${postUrl ? `\n${tgEscape(postUrl)}` : ""}`, { html: true });
  await notifyEmail("✅ Your LinkedIn post is live", `<p>Published:</p><pre>${commentary.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>${postUrl ? `<p><a href="${postUrl}">View on LinkedIn</a></p>` : ""}`);
  console.log("Posted.", postUrl);
} else {
  const err = await res.text();
  await db.from("linkedin_posts").update({ status: "failed", warning: `post ${res.status}`, updated_at: new Date().toISOString() }).eq("id", postId);
  await notifyTelegram(`🔴 <b>LinkedIn post failed</b> (${res.status}). Check the app permissions / reconnect.`, { html: true });
  console.error(res.status, err.slice(0, 300));
  process.exit(1);
}
