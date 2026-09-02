// scripts/linkedin-document-spike.mjs
// SPIKE — answers ONE question: will LinkedIn accept a DOCUMENT (PDF carousel) upload with the
// permission this app already holds (`w_member_social`)?
//
// WHY THIS EXISTS: images are proven to work on this scope (scripts/linkedin-image-spike.mjs), but
// documents are a DIFFERENT endpoint (/rest/documents) behind a DIFFERENT product entitlement.
// This app has already hit one permanent 403 wall — engagement reads — where the docs implied
// otherwise. Documentation is not proof. Nothing about the carousel work should be planned until
// this returns a status code.
//
// PUBLISHES NOTHING. It performs only the first two steps of the three-step flow:
//   1. initializeUpload  -> LinkedIn reserves a document slot, returns an upload URL + document URN
//   2. PUT the bytes     -> the PDF is stored against your account, still attached to no post
//   3. create a post     -> NOT DONE HERE. This is the step that would appear on your feed.
// An uploaded-but-unused document is invisible to everyone and expires on its own.
//
// The test file is built with pdfkit — the SAME library the real carousel would use — rather than a
// hardcoded one-page blob. That way a green result also proves LinkedIn accepts pdfkit's output and
// its multi-page structure, not merely that some PDF passed.
//
// Run: node scripts/linkedin-document-spike.mjs   (needs TOKEN_ENC_KEY + SUPABASE_* + LinkedIn app)
import { createClient } from "@supabase/supabase-js";
import PDFDocument from "pdfkit";
import { env } from "../lib/env.js";
import { openValue } from "../lib/crypto.js";
import { LINKEDIN_API_VERSION } from "../lib/linkedin.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));

const step = (n, msg) => console.log(`\n[${n}] ${msg}`);
const fail = (msg) => { console.log(`\n❌ RESULT: ${msg}`); process.exit(1); };

/**
 * A minimal but REAL two-page square PDF. Square (1080pt) because that is the shape a LinkedIn
 * carousel renders in feed, and two pages because a one-page PDF would not exercise the multi-page
 * path the carousel actually needs.
 */
function testPdf() {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [1080, 1080], margin: 80, info: { Title: "Upload capability probe" } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    for (const [i, line] of ["Slide one", "Slide two"].entries()) {
      if (i) doc.addPage();
      doc.rect(0, 0, 1080, 1080).fill("#0E1116");
      doc.fillColor("#C6F24E").fontSize(64).font("Helvetica-Bold").text(line, 80, 480);
    }
    doc.end();
  });
}

const { data: tk } = await db.from("kv").select("value").eq("key", "linkedin:token").maybeSingle();
const token = openValue(tk?.value);
if (!token?.access_token) fail("No LinkedIn token stored — connect LinkedIn on the dashboard first.");
if (!token?.person_urn) fail("Token has no person_urn — reconnect LinkedIn so the author URN is stored.");

console.log(`LinkedIn-Version: ${LINKEDIN_API_VERSION}`);
console.log(`author: ${token.person_urn}`);
console.log(`scopes recorded on the token: ${token.scope || "(not stored)"}`);

const pdf = await testPdf();
console.log(`test PDF: ${pdf.length} bytes, 2 pages, 1080x1080pt, built with pdfkit`);

const H = {
  Authorization: `Bearer ${token.access_token}`,
  "LinkedIn-Version": LINKEDIN_API_VERSION,
  "X-Restli-Protocol-Version": "2.0.0",
  "Content-Type": "application/json",
};

// ---- Step 1: reserve an upload slot -------------------------------------------------------
step(1, "POST /rest/documents?action=initializeUpload");
let init;
try {
  const r = await fetch("https://api.linkedin.com/rest/documents?action=initializeUpload", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ initializeUploadRequest: { owner: token.person_urn } }),
  });
  const text = await r.text();
  console.log(`    -> HTTP ${r.status}`);
  if (!r.ok) {
    console.log(`    -> body: ${text.slice(0, 400)}`);
    if (r.status === 403) fail("403 on initializeUpload — w_member_social does NOT cover document upload for this app. PDF carousels are NOT possible without additional LinkedIn product access. Same wall as engagement reads.");
    if (r.status === 401) fail("401 — the LinkedIn sign-in has expired. Reconnect on the dashboard and re-run.");
    if (r.status === 426) fail(`426 — LINKEDIN_API_VERSION ${LINKEDIN_API_VERSION} has been sunset. Bump lib/linkedin.js in BOTH repos and re-run.`);
    fail(`initializeUpload returned ${r.status}. Documents blocked for now.`);
  }
  init = JSON.parse(text)?.value;
} catch (e) {
  fail(`initializeUpload threw: ${e.message}`);
}

const uploadUrl = init?.uploadUrl;
const docUrn = init?.document;
console.log(`    -> document URN: ${docUrn}`);
console.log(`    -> upload URL  : ${String(uploadUrl).slice(0, 80)}…`);
if (!uploadUrl || !docUrn) {
  console.log(`    -> full value: ${JSON.stringify(init).slice(0, 400)}`);
  fail("initializeUpload succeeded but returned no uploadUrl/document URN — the response shape differs from the images API and the carousel code would need to read a different field.");
}

// ---- Step 2: send the bytes ---------------------------------------------------------------
step(2, `PUT ${pdf.length} bytes (application/pdf) to the upload URL`);
try {
  const r = await fetch(uploadUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/pdf" },
    body: pdf,
  });
  console.log(`    -> HTTP ${r.status}`);
  if (!r.ok) fail(`byte upload returned ${r.status}: ${(await r.text()).slice(0, 300)}`);
} catch (e) {
  fail(`byte upload threw: ${e.message}`);
}

// ---- Step 3: deliberately NOT done --------------------------------------------------------
step(3, "SKIPPED ON PURPOSE — creating the post is what would publish to your feed.");

console.log(`
✅ RESULT: LinkedIn ACCEPTED a multi-page PDF upload on the permission this app already has.
   Document URN: ${docUrn}

   Nothing was published. To attach a carousel to a real post, /rest/posts takes:
     content: { media: { id: "${docUrn}", title: "..." } }
   Note it is \`title\`, NOT \`altText\` — documents have no alt-text field, which is why slides
   need a real text layer rather than being pictures of text.

   So PDF carousels ARE possible. The remaining work is producing the slides, not getting permission.`);
