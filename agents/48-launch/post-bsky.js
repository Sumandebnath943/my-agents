// agents/48-launch/post-bsky.js — publishes the approved Bluesky launch post (free API).
// Reads kv launch:pending (set by the drafting step), creates a Bluesky session with the app
// password, posts the record, clears the pending state, and confirms on Telegram.
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { getState, setState } from "../../lib/store.js";
import { notifyTelegram, tgEscape } from "../../lib/notify.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));

const pending = await getState("launch:pending");
if (!pending?.bluesky) { console.log("Nothing pending."); process.exit(0); }

const s = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ identifier: env("BSKY_HANDLE"), password: env("BSKY_APP_PASSWORD") }),
}).then((r) => r.json());
if (!s.accessJwt) { await notifyTelegram("🔴 Bluesky login failed — check BSKY_HANDLE / app password.", { html: true }); process.exit(1); }

const text = String(pending.bluesky).slice(0, 300); // Bluesky hard limit
const res = await fetch("https://bsky.social/xrpc/com.atproto.repo.createRecord", {
  method: "POST",
  headers: { Authorization: `Bearer ${s.accessJwt}`, "Content-Type": "application/json" },
  body: JSON.stringify({ repo: s.did, collection: "app.bsky.feed.post", record: { $type: "app.bsky.feed.post", text, createdAt: new Date().toISOString() } }),
});

if (res.ok) {
  const body = await res.json().catch(() => ({}));
  const rkey = String(body.uri || "").split("/").pop();
  const postUrl = rkey ? `https://bsky.app/profile/${env("BSKY_HANDLE")}/post/${rkey}` : `https://bsky.app/profile/${env("BSKY_HANDLE")}`;
  try { await db.from("launches").insert({ repo: pending.repo, platform: "bluesky", url: postUrl }); } catch {}
  await setState("launch:pending", null);
  await notifyTelegram(`✅ <b>Posted to Bluesky</b> — ${tgEscape(pending.name || "")}\n${tgEscape(postUrl)}`, { html: true });
  console.log("Posted to Bluesky.", postUrl);
} else {
  const t = await res.text();
  await notifyTelegram(`🔴 Bluesky post failed (${res.status}).`, { html: true });
  console.error(res.status, t.slice(0, 300));
  process.exit(1);
}
