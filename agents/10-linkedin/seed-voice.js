// agents/10-linkedin/seed-voice.js
// Seeds the reference posts (agents/10-linkedin/references.js) into the shared voice memory so the
// trained tone survives even outside the draft prompt and can be shared by other brand agents.
// The exemplars are ALSO injected straight from code at draft time (referenceBlock) — this is the
// "+ memory" half of the code+memory strategy: durable, deduped, resilient to a memory-table reset.
//
// Run manually after you edit references.js:  npm run linkedin:seed-voice
import { REFERENCE_POSTS } from "./references.js";
import { remember } from "../../lib/memory.js";

const VOICE_SCOPE = { scope: "user", scopeKey: "linkedin_voice", source: "reference_seed" };

const posts = REFERENCE_POSTS.map((p) => String(p).trim()).filter(Boolean);
if (!posts.length) {
  console.log("No reference posts in references.js yet — add some, then re-run.");
  process.exit(0);
}

let ok = 0;
for (const [i, post] of posts.entries()) {
  const mem = `LinkedIn voice/tone exemplar (imitate this cadence, line-break rhythm and hook style, never the content): ${post}`;
  const r = await remember(mem, VOICE_SCOPE);
  console.log(`exemplar ${i + 1}: ${r.action}`);
  if (r.action !== "skip") ok++;
}
console.log(`Seeded ${ok}/${posts.length} reference posts into voice memory.`);

// FAIL the job when nothing was stored. lib/memory.js is best-effort (it swallows embedding and DB
// errors and returns "skip"), so without this the workflow would exit green having saved NOTHING —
// a false success that hides an embedding outage exactly like the retired-model 404 did.
if (ok === 0) {
  console.error(`FAILED: 0 of ${posts.length} exemplars were saved. Every remember() returned "skip", which means embeddings or the DB write failed — check the errors logged above.`);
  process.exit(1);
}
if (ok < posts.length) console.warn(`WARNING: only ${ok}/${posts.length} saved — re-run to retry the rest.`);
process.exit(0);
