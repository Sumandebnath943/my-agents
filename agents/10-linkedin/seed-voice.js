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
process.exit(0);
