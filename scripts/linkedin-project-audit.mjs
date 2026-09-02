// scripts/linkedin-project-audit.mjs
// How often do published posts actually NAME one of Suman's shipped products, and which ones?
//
// WHY THIS EXISTS: the answer drifted to 27% overall and 20% across the last twenty posts, and
// nobody noticed for months because nothing measured it. The distribution was worse than the rate —
// ROASmind 19 mentions, IMPRINT 3, House of Namus 1, and NINE shipped products never mentioned once
// across 86 posts. The portfolio was not being showcased; one project was being reused.
//
// The agent was already finding the connection: 57% of stored `grounding` lines named a project
// while only 27% of post bodies did. It decided privately and left it out of the post.
//
// Run this after changing the rotation block or the drafting prompt in 10a-draft.js. Target is
// roughly HALF of posts naming a product — high enough to build the portfolio, low enough that
// nothing has to be forced.
//
// READ-ONLY. No storage, no publishing, no token required.
//
// Run: node scripts/linkedin-project-audit.mjs [--recent N]
import { createClient } from "@supabase/supabase-js";
import { env } from "../lib/env.js";
import { PROFILE, projectsNamedIn } from "../lib/profile.js";


const args = process.argv.slice(2);
const i = args.indexOf("--recent");
const RECENT = Number(i >= 0 && args[i + 1] ? args[i + 1] : 20);

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));
const { data, error } = await db.from("linkedin_posts").select("id,post,grounding").order("id");
if (error) { console.error("could not read linkedin_posts:", error.message); process.exit(1); }

const rows = (data || []).filter((r) => r.post && r.post.length > 100);
if (!rows.length) { console.error("no posts to audit"); process.exit(1); }

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const counts = Object.fromEntries(PROFILE.projectNames.map((n) => [n, 0]));
let named = 0, grounded = 0, groundingNamesProject = 0;

for (const r of rows) {
  const found = projectsNamedIn(r.post);
  if (found.length) named++;
  for (const f of found) counts[f]++;
  if (r.grounding) {
    grounded++;
    // The gap that matters: the model identified a project and then did not write it in the post.
    if (PROFILE.projectNames.some((n) => new RegExp(`\\b${esc(n)}`, "i").test(r.grounding))) groundingNamesProject++;
  }
}

const recent = rows.slice(-RECENT);
const recentNamed = recent.filter((r) => projectsNamedIn(r.post).length).length;
const pct = (n, d = rows.length) => `${Math.round((n / d) * 100)}%`;

console.log(`\nposts analysed: ${rows.length}`);
console.log(`name a product IN THE POST     : ${named} (${pct(named)})   <- the number that matters`);
console.log(`grounding line names a product : ${groundingNamesProject} of ${grounded} (${pct(groundingNamesProject)})`);
if (groundingNamesProject > named) {
  console.log(`  ⚠️  ${groundingNamesProject - named} post(s) identified a project and never named it in the text.`);
}
console.log(`last ${recent.length} posts                 : ${recentNamed}/${recent.length} (${pct(recentNamed, recent.length)})`);

console.log("\nper product:");
const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
for (const [name, n] of sorted) console.log(`  ${name.padEnd(18)} ${String(n).padStart(3)}${n === 0 ? "   <- never mentioned" : ""}`);

const silent = sorted.filter(([, n]) => n === 0).length;
console.log(`\n${silent} of ${PROFILE.projectNames.length} products have never been mentioned.`);

console.log(`
Target: roughly HALF of posts naming a product — enough to build the portfolio, not so much that
anything has to be forced. Spread matters as much as the rate: a 50% rate that is all one product
is the same problem wearing a better number.

Baseline before the rotation block was added (2026-09-02, 86 posts):
  named in post 27%  ·  last 20  20%  ·  ROASmind 19, IMPRINT 3, everything else 0`);
