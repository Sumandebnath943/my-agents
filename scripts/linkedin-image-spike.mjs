// scripts/linkedin-image-spike.mjs
// SPIKE — answers ONE question: will LinkedIn accept an image upload with the permission this app
// already holds (`w_member_social`)? Reading engagement needs partner-tier access we do not have;
// image upload is documented to work on w_member_social, but documentation is not proof.
//
// PUBLISHES NOTHING. It performs only the first two steps of the three-step flow:
//   1. initializeUpload  -> LinkedIn reserves an image slot and returns an upload URL + image URN
//   2. PUT the bytes     -> the image is stored against your account, still attached to no post
//   3. create a post     -> NOT DONE HERE. This is the step that would appear on your feed.
// An uploaded-but-unused image is invisible to everyone and expires on its own.
//
// Run: node scripts/linkedin-image-spike.mjs      (needs TOKEN_ENC_KEY + SUPABASE_* + LinkedIn app)
import { createClient } from "@supabase/supabase-js";
import { env } from "../lib/env.js";
import { openValue } from "../lib/crypto.js";
import { LINKEDIN_API_VERSION } from "../lib/linkedin.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));

// A 1x1 PNG. Deliberately the smallest valid image that exists: this spike is testing whether the
// API accepts an upload at all, not whether a design looks good.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const step = (n, msg) => console.log(`\n[${n}] ${msg}`);
const fail = (msg) => { console.log(`\n❌ RESULT: ${msg}`); process.exit(1); };

const { data: tk } = await db.from("kv").select("value").eq("key", "linkedin:token").maybeSingle();
const token = openValue(tk?.value);
if (!token?.access_token) fail("No LinkedIn token stored — connect LinkedIn on the dashboard first.");
if (!token?.person_urn) fail("Token has no person_urn — reconnect LinkedIn so the author URN is stored.");

console.log(`LinkedIn-Version: ${LINKEDIN_API_VERSION}`);
console.log(`author: ${token.person_urn}`);
console.log(`scopes recorded on the token: ${token.scope || "(not stored)"}`);

const H = {
  Authorization: `Bearer ${token.access_token}`,
  "LinkedIn-Version": LINKEDIN_API_VERSION,
  "X-Restli-Protocol-Version": "2.0.0",
  "Content-Type": "application/json",
};

// ---- Step 1: reserve an upload slot -------------------------------------------------------
step(1, "POST /rest/images?action=initializeUpload");
let init;
try {
  const r = await fetch("https://api.linkedin.com/rest/images?action=initializeUpload", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ initializeUploadRequest: { owner: token.person_urn } }),
  });
  const text = await r.text();
  console.log(`    -> HTTP ${r.status}`);
  if (!r.ok) {
    console.log(`    -> body: ${text.slice(0, 400)}`);
    if (r.status === 403) fail("403 on initializeUpload — w_member_social does NOT cover image upload for this app. Images are not possible without more access.");
    if (r.status === 401) fail("401 — the LinkedIn sign-in has expired. Reconnect on the dashboard and re-run.");
    fail(`initializeUpload returned ${r.status}. Images blocked for now.`);
  }
  init = JSON.parse(text)?.value;
} catch (e) {
  fail(`initializeUpload threw: ${e.message}`);
}

const uploadUrl = init?.uploadUrl;
const imageUrn = init?.image;
console.log(`    -> image URN : ${imageUrn}`);
console.log(`    -> upload URL: ${String(uploadUrl).slice(0, 80)}…`);
if (!uploadUrl || !imageUrn) fail("initializeUpload succeeded but returned no uploadUrl/image URN.");

// ---- Step 2: send the bytes ---------------------------------------------------------------
step(2, `PUT ${PNG_1X1.length} bytes to the upload URL`);
try {
  const r = await fetch(uploadUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "image/png" },
    body: PNG_1X1,
  });
  console.log(`    -> HTTP ${r.status}`);
  if (!r.ok) fail(`byte upload returned ${r.status}: ${(await r.text()).slice(0, 300)}`);
} catch (e) {
  fail(`byte upload threw: ${e.message}`);
}

// ---- Step 3: deliberately NOT done --------------------------------------------------------
step(3, "SKIPPED ON PURPOSE — creating the post is what would publish to your feed.");

console.log(`
✅ RESULT: LinkedIn ACCEPTED an image upload on the permission this app already has.
   Image URN: ${imageUrn}

   Nothing was published. To attach an image to a real post, /rest/posts takes:
     content: { media: { id: "${imageUrn}", altText: "..." } }

   So images ARE possible. The remaining work is producing the picture, not getting permission.`);
