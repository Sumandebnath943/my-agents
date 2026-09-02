// evals/linkedin/run.mjs
// Guards stripMarkdown() — LinkedIn/Bluesky/Mastodon render literal text, so any leaked markdown
// (**bold**, ## headings, `code`, [x](url)) shows as raw characters in a published post. This is
// the "kill markdown leakage" contract for social output. Pure + offline.
import { runCases, isMain } from "../_lib.mjs";
import { stripMarkdown } from "../../lib/email-template.js";
import { projectsNamedIn } from "../../lib/profile.js";

// Markdown artifacts that must NEVER survive into a social post.
const LEAK_PATTERNS = [
  { re: /\*\*/, label: "bold **" },
  { re: /(^|\s)#{1,6}\s/, label: "heading #" },
  { re: /`/, label: "backtick" },
  { re: /\]\(https?:\/\//, label: "md link ](url" },
  { re: /__/, label: "bold __" },
];

export function run() {
  const cases = [
    { id: "bold-stars",   in: "This is **important** today",       contains: "important" },
    { id: "bold-unders",  in: "This is __important__ today",       contains: "important" },
    { id: "heading",      in: "## Big News\nwe shipped it",        contains: "Big News" },
    { id: "inline-code",  in: "run `npm test` first",              contains: "npm test" },
    { id: "md-link",      in: "see [the docs](https://x.com/docs)", contains: "the docs" },
    { id: "bullet",       in: "- first point",                     contains: "first point" },
    { id: "mixed",        in: "# Title\n**bold** and `code` and [l](http://a.b)", contains: "bold" },
    { id: "clean-passthrough", in: "Just a normal sentence.",      contains: "normal sentence" },
  ];

  // projectsNamedIn drives both the portfolio rotation in 10a-draft.js and the audit script, so a
  // false positive inflates the measured rate and a false negative makes the rotation re-suggest a
  // product that was just used. The two strip rules are the subtle part: MIGI is in the signature
  // of EVERY post by construction, and "Via <outlet>" credits someone else's newsroom.
  const projectCases = [
    { id: "signature-not-a-mention", in: "Governance is architecture.\n\n🤖 Drafted by MIGI, my AI agent — edited and published by me.", expect: [] },
    { id: "via-credit-not-a-mention", in: "Governance is architecture.\n\nVia VentureBeat", expect: [] },
    { id: "names-a-product", in: "I hit this building ROASmind, our marketing OS.", expect: ["ROASmind"] },
    { id: "dotted-name-matches", in: "D-PE.ai started as a prompt scratchpad.", expect: ["D-PE.ai"] },
    { id: "case-insensitive", in: "imprint taught me this the hard way.", expect: ["IMPRINT"] },
    { id: "two-products", in: "LEGATUS and CITE share the same vault primitive.", expect: ["LEGATUS", "CITE"] },
    { id: "no-product-no-mention", in: "Most teams automate the wrong half of the job.", expect: [] },
  ];

  return [runCases("linkedin · stripMarkdown() no-leak", cases, (c) => {
    const out = stripMarkdown(c.in);
    const leak = LEAK_PATTERNS.find((p) => p.re.test(out));
    if (leak) return { ok: false, note: `leaked ${leak.label}: "${out}"` };
    if (c.contains && !out.includes(c.contains)) return { ok: false, note: `dropped content "${c.contains}": "${out}"` };
    return { ok: true };
  }),

  runCases("linkedin · projectsNamedIn() portfolio detection", projectCases, (c) => {
    const got = projectsNamedIn(c.in);
    const same = got.length === c.expect.length && c.expect.every((e) => got.includes(e));
    return same ? { ok: true } : { ok: false, note: `expected [${c.expect}] got [${got}]` };
  })];
}

if (isMain(import.meta.url)) {
  const results = run();
  process.exit(results.some((r) => r.fail) ? 1 : 0);
}
