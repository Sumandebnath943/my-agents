// scripts/linkedin-slide-audit.mjs
// Runs the carousel splitter over EVERY post in linkedin_posts and reports slides whose headline
// does not read as a claim.
//
// WHY THIS EXISTS: the eval suite passed at 100% while 15.4% of slides built from real posts were
// unreadable. The fixtures were four sentences I made up, and every one of them was cleaner than
// anything Suman actually writes — self-contained, no setup-then-claim structure, no lead-in lines,
// no heading/detail pairs. The evals were fine; the DATA was fake. This script is the counterweight:
// evals guard behaviour that must never regress, this measures quality against the real corpus.
//
// Run it after ANY change to agents/10-linkedin/slides.js. A rise in the flag rate, or a jump in
// refusals, means the change made real decks worse regardless of what the evals say.
//
// READ-ONLY. Touches no storage, publishes nothing, writes nothing back.
//
// Run: node scripts/linkedin-slide-audit.mjs [--examples N] [--flag <id>]
//      (needs SUPABASE_URL + SUPABASE_KEY; TOKEN_ENC_KEY is NOT required — no tokens are read)
import { createClient } from "@supabase/supabase-js";
import { env } from "../lib/env.js";
import { stripMarkdown } from "../lib/email-template.js";
import { buildSlides } from "../agents/10-linkedin/slides.js";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const MAX_EXAMPLES = Number(argOf("--examples", 25));
const ONLY_FLAG = argOf("--flag", null);

/**
 * Heuristics for "this headline is not a claim".
 *
 * DELIBERATELY OVER-REPORTING. `weak-open` in particular fires on complete, perfectly good
 * sentences that happen to start with "This"/"That"/"But" — at the last measurement every one of
 * those was a false positive. The number is a TREND, not a defect count: what matters is whether it
 * moves when you change the splitter, and which examples appear. Do not chase it to zero, and do
 * not add a threshold that fails a build on it.
 */
const FLAGS = [
  { id: "connector", re: /:\s*$/, why: "ends on a colon — a lead-in, not a claim" },
  { id: "dangling", re: /^(?:by|when|if|after|with|because|while|as|since|although|though|unless)\b[^,]*$/i, why: "subordinate clause with no main clause" },
  { id: "weak-open", re: /^(?:here'?s|let'?s|let me|imagine|instead|so|and|but|because|which|that means|this)\b/i, why: "opens on a connector (over-reports; usually fine)" },
  { id: "truncated", re: /…$/, why: "ellipsised — a claim lost its ending" },
  { id: "fragment", re: /^.{0,24}$/, noBody: true, why: "too short, with nothing under it" },
  { id: "preamble", re: /^(?:i'?ve|i have|in my|from my|over the|after) .{0,60}$/i, why: "setup clause, payload missing" },
];

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));
const { data, error } = await db.from("linkedin_posts").select("id,headline,post").order("id");
if (error) { console.error("could not read linkedin_posts:", error.message); process.exit(1); }

const rows = (data || []).filter((r) => r.post && r.post.length > 100);
if (!rows.length) { console.error("no posts to audit"); process.exit(1); }

let slides = 0, flagged = 0;
const byFlag = {};
const refusals = {};
const examples = [];

for (const r of rows) {
  const post = stripMarkdown(r.post);
  const deck = buildSlides(post, { sourceHeadline: r.headline || "" });

  if (!deck.ok) {
    // Group by shape, not by exact text, so "only 2 usable point(s)" and "only 1" collapse together.
    const key = deck.reason.replace(/\d+/g, "N");
    refusals[key] = (refusals[key] || 0) + 1;
    continue;
  }

  for (const s of deck.slides) {
    if (s.kind === "brand") continue;          // furniture, deliberately not post content
    slides++;
    const hit = FLAGS.find((f) => f.re.test(s.title || "") && (!f.noBody || !s.body));
    if (!hit || (ONLY_FLAG && hit.id !== ONLY_FLAG)) continue;
    flagged++;
    byFlag[hit.id] = (byFlag[hit.id] || 0) + 1;
    if (examples.length < MAX_EXAMPLES) {
      examples.push(`  [${String(r.id).padStart(3)}] ${hit.id.padEnd(9)} ${JSON.stringify(s.title)}${s.body ? `\n            >> ${s.body.slice(0, 76)}` : "  (no body)"}`);
    }
  }
}

const refused = Object.values(refusals).reduce((a, b) => a + b, 0);
const pct = slides ? ((flagged / slides) * 100).toFixed(1) : "0.0";

console.log(`\nposts ${rows.length} · decks built ${rows.length - refused} · refused ${refused} (${((refused / rows.length) * 100).toFixed(0)}%)`);
console.log(`slides ${slides} · flagged ${flagged} (${pct}%)\n`);

if (Object.keys(byFlag).length) {
  console.log("by flag:");
  for (const [id, n] of Object.entries(byFlag).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${id.padEnd(10)} ${String(n).padStart(3)}   ${FLAGS.find((f) => f.id === id).why}`);
  }
}

if (refused) {
  console.log("\nrefusals (these fall back to the insight card, which is fine):");
  for (const [why, n] of Object.entries(refusals).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${why}`);
}

if (examples.length) {
  console.log(`\nexamples (${examples.length} of ${flagged}${ONLY_FLAG ? `, filtered to "${ONLY_FLAG}"` : ""}):`);
  console.log(examples.join("\n"));
}

// Recorded so a future run has something to compare against without digging through git history.
console.log(`
Baseline for comparison — measured 2026-09-02 over 85 posts, after the corpus rebuild:
  refused 6 (7%) · slides 405 · flagged 23 (5.7%)
  and every one of those 23 was checked by hand and was a FALSE POSITIVE on a complete sentence.

A materially higher flag rate, or a jump in refusals, means a splitter change made real decks worse.
Read the examples before believing the number.`);
