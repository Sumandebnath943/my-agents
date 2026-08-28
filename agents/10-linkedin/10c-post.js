// agents/10-linkedin/10c-post.js
// Publishes an approved LinkedIn post (env POST_ID). Reads the token from Supabase kv
// (minted by the dashboard Connect flow), refreshes it if old, posts via the Posts API,
// updates the audit row, and confirms on Telegram + email.
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { notifyEmail, notifyTelegram, tgEscape } from "../../lib/notify.js";
import { renderEmail, stripMarkdown } from "../../lib/email-template.js";
import { sealValue, openValue } from "../../lib/crypto.js";
import { LINKEDIN_API_VERSION } from "../../lib/linkedin.js";

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
      await db.from("kv").upsert({ key: "linkedin:token", value: sealValue(updated), updated_at: new Date().toISOString() });
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
const token = openValue(tk?.value);
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
// Strip any markdown FIRST — LinkedIn shows literal `**`/`#` otherwise (the reserved chars get
// backslash-escaped and render as text). Hashtags are appended separately (kept clickable).
const cleanPost = stripMarkdown(row.post);
const commentary = (escapeLI(cleanPost) + (row.hashtags ? `\n\n${row.hashtags}` : "")).trim();
// ---- Optional insight card -----------------------------------------------------------------
// OFF BY DEFAULT: set LINKEDIN_POST_IMAGE=1 to attach one. Publishing is irreversible, so this
// stays opt-in until the card has been eyeballed on a real post. Every failure path below falls
// through to a text-only post — an image problem must never cost you the post itself.
// Upload permission was verified against the live API (scripts/linkedin-image-spike.mjs).
let mediaId = null;
let cardAlt = null;   // the card's OWN line — never the source headline, which is the thing being avoided
if (process.env.LINKEDIN_POST_IMAGE === "1") {
  try {
    const { renderCard, pickCardLine } = await import("./card.js");
    const { callLLM } = await import("../../lib/llm.js");

    // The card must never restate the source headline. On 2026-08-28 a card shipped carrying 92%
    // of VentureBeat's headline in 70px type under Suman's name — legal or not, that reads as
    // passing off. pickCardLine walks past any candidate too close to the source, and only then
    // tries a rephrase, which is VERIFIED against the same bar rather than trusted.
    const rephrase = async (line) => callLLM([
      { role: "system", content: "Rewrite the sentence so it expresses the same idea in completely different words. Change the sentence structure and vocabulary, not just a word or two. Keep it under 150 characters, declarative, no quotes, no hashtags. Reply with the rewritten sentence and nothing else." },
      { role: "user", content: `Rewrite this, avoiding the phrasing of this headline: "${row.headline || ""}"\n\nSentence: ${line}` },
    ]);

    const picked = await pickCardLine(cleanPost, { sourceHeadline: row.headline || "", rephrase });
    if (!picked.line) throw new Error(`no card line clears the source-similarity bar (best ${picked.similarity})`);
    console.log(`card: line via ${picked.via} (similarity to source ${picked.similarity})`);

    const png = renderCard({ quote: picked.line });
    if (!png) throw new Error("card renderer returned nothing");

    const initRes = await fetch("https://api.linkedin.com/rest/images?action=initializeUpload", {
      method: "POST",
      headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json", "LinkedIn-Version": LINKEDIN_API_VERSION, "X-Restli-Protocol-Version": "2.0.0" },
      body: JSON.stringify({ initializeUploadRequest: { owner: token.person_urn } }),
    });
    if (!initRes.ok) throw new Error(`initializeUpload ${initRes.status}: ${(await initRes.text()).slice(0, 160)}`);
    const init = (await initRes.json())?.value;
    if (!init?.uploadUrl || !init?.image) throw new Error("initializeUpload returned no uploadUrl/image");

    const put = await fetch(init.uploadUrl, {
      method: "PUT",
      headers: { Authorization: `Bearer ${access}`, "Content-Type": "image/png" },
      body: png,
    });
    if (!put.ok) throw new Error(`image upload ${put.status}`);

    mediaId = init.image;
    cardAlt = picked.line;
    console.log(`card: attached ${png.length} bytes as ${mediaId} — "${picked.line.slice(0, 70)}"`);
  } catch (e) {
    console.error(`card: SKIPPED, posting text-only — ${e.message}`);
    mediaId = null;
  }
}

const res = await fetch("https://api.linkedin.com/rest/posts", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${access}`,
    "Content-Type": "application/json",
    "LinkedIn-Version": LINKEDIN_API_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
  },
  body: JSON.stringify({
    author: token.person_urn,
    commentary,
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
    ...(mediaId ? { content: { media: { id: mediaId, altText: (cardAlt || "Insight card").slice(0, 300) } } } : {}),
  }),
});

if (res.ok || res.status === 201) {
  const urn = res.headers.get("x-restli-id") || res.headers.get("x-linkedin-id") || "";
  const postUrl = urn ? `https://www.linkedin.com/feed/update/${urn}` : "";
  await db.from("linkedin_posts").update({ status: "posted", post_url: postUrl, updated_at: new Date().toISOString() }).eq("id", postId);
  await notifyTelegram(`✅ <b>Posted to LinkedIn</b>${postUrl ? `\n${tgEscape(postUrl)}` : ""}`, { html: true });
  await notifyEmail("✅ Your LinkedIn post is live", renderEmail({
    title: "Your LinkedIn post is live", kicker: "PUBLISHED", accent: "#0A66C2",
    blocks: [
      { type: "text", html: cleanPost.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>") + (row.hashtags ? `<br><br><span style="color:#0A66C2;font-weight:600;">${row.hashtags}</span>` : "") },
      ...(postUrl ? [{ type: "hero", ramp: "blue", title: "View it on LinkedIn", buttonLabel: "Open post →", link: postUrl }] : []),
    ],
    footer: "LinkedIn autopilot",
  }));
  // Offer to repurpose the same content to the free socials (handled in-process by the webhook).
  await notifyTelegram("♻️ <b>Repurpose this?</b> Shorten &amp; post it to your other socials, or pick different news.", {
    html: true,
    buttons: [
      [{ text: "🦋 Bluesky", callback_data: `soc:rp:bluesky:${postId}` }, { text: "🐘 Mastodon", callback_data: `soc:rp:mastodon:${postId}` }],
      [{ text: "🌐 Both", callback_data: `soc:rp:both:${postId}` }, { text: "🆕 Different news", callback_data: "soc:new" }],
    ],
  });
  console.log("Posted.", postUrl);
} else {
  const err = await res.text();
  await db.from("linkedin_posts").update({ status: "failed", warning: `post ${res.status}`, updated_at: new Date().toISOString() }).eq("id", postId);
  await notifyTelegram(`🔴 <b>LinkedIn post failed</b> (${res.status}). Check the app permissions / reconnect.`, { html: true });
  console.error(res.status, err.slice(0, 300));
  process.exit(1);
}
