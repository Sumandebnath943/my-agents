// scripts/social-image-spike.mjs
// SPIKE — proves the insight card can be attached to Bluesky and Mastodon, WITHOUT posting.
//
// Both platforms upload media as a separate step from creating the post, so the risky half can be
// exercised on its own: upload the bytes, get an id back, stop. An uploaded-but-unreferenced blob
// is visible to nobody and is garbage-collected by the server.
//   Bluesky : com.atproto.repo.uploadBlob        -> blob ref   (createRecord NOT called)
//   Mastodon: POST /api/v2/media                 -> media id   (POST /statuses NOT called)
//
// Uses the real archived card from Supabase storage, so this tests the actual bytes that would
// ship — not a placeholder.
//
// Run: node scripts/social-image-spike.mjs [linkedinPostId]
import { createClient } from "@supabase/supabase-js";
import { env } from "../lib/env.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));
const postId = process.argv[2] || process.env.CARD_POST_ID || "78";

console.log(`fetching archived card: linkedin/card-${postId}.png`);
const dl = await db.storage.from("linkedin").download(`card-${postId}.png`);
if (dl.error || !dl.data) {
  console.log(`❌ no archived card for post ${postId} — publish a post with LINKEDIN_POST_IMAGE=1 first.`);
  process.exit(1);
}
const bytes = new Uint8Array(await dl.data.arrayBuffer());
console.log(`   ${bytes.length} bytes\n`);

let ok = 0, skipped = 0, failed = 0;

// ---- Bluesky --------------------------------------------------------------------------------
if (!process.env.BSKY_HANDLE || !process.env.BSKY_APP_PASSWORD) {
  console.log("🦋 Bluesky: SKIPPED — BSKY_HANDLE / BSKY_APP_PASSWORD not set"); skipped++;
} else if (bytes.length > 976_000) {
  console.log(`🦋 Bluesky: FAIL — ${bytes.length} bytes exceeds the 1MB per-image ceiling`); failed++;
} else {
  try {
    const s = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: process.env.BSKY_HANDLE, password: process.env.BSKY_APP_PASSWORD }),
    }).then((r) => r.json());
    if (!s.accessJwt) throw new Error(`login failed: ${JSON.stringify(s).slice(0, 140)}`);
    console.log(`🦋 Bluesky: logged in as ${s.handle}`);

    const up = await fetch("https://bsky.social/xrpc/com.atproto.repo.uploadBlob", {
      method: "POST", headers: { Authorization: `Bearer ${s.accessJwt}`, "Content-Type": "image/png" }, body: bytes,
    });
    if (!up.ok) throw new Error(`uploadBlob ${up.status}: ${(await up.text()).slice(0, 160)}`);
    const blob = (await up.json())?.blob;
    if (!blob) throw new Error("uploadBlob returned no blob ref");
    console.log(`🦋 Bluesky: ✅ blob accepted — ${blob.ref?.$link || JSON.stringify(blob).slice(0, 60)}`);
    console.log("   (createRecord NOT called — nothing posted)"); ok++;
  } catch (e) { console.log(`🦋 Bluesky: ❌ ${e.message}`); failed++; }
}

// ---- Mastodon -------------------------------------------------------------------------------
let inst = (process.env.MASTODON_INSTANCE || "").trim();
if (!inst || !process.env.MASTODON_TOKEN) {
  console.log("🐘 Mastodon: SKIPPED — MASTODON_INSTANCE / MASTODON_TOKEN not set for this workflow"); skipped++;
} else {
  try {
    if (!/^https?:\/\//i.test(inst)) inst = "https://" + inst;
    inst = new URL(inst).origin;
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "image/png" }), "card.png");
    form.append("description", "Insight card (spike upload — not attached to any post)");
    const up = await fetch(`${inst}/api/v2/media`, {
      method: "POST", headers: { Authorization: `Bearer ${process.env.MASTODON_TOKEN}`, Accept: "application/json", "User-Agent": "migi/1.0" }, body: form,
    });
    if (!up.ok && up.status !== 202) throw new Error(`media ${up.status}: ${(await up.text()).slice(0, 160)}`);
    const m = await up.json().catch(() => ({}));
    if (!m?.id) throw new Error("no media id returned");
    console.log(`🐘 Mastodon: ✅ media accepted (HTTP ${up.status}) — id ${m.id}`);
    console.log("   (POST /statuses NOT called — nothing posted)"); ok++;
  } catch (e) { console.log(`🐘 Mastodon: ❌ ${e.message}`); failed++; }
}

console.log(`\nRESULT: ${ok} accepted, ${skipped} skipped, ${failed} failed. Nothing was published.`);
process.exit(failed ? 1 : 0);
