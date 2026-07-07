// evals/linkedin/run.mjs
// Guards stripMarkdown() — LinkedIn/Bluesky/Mastodon render literal text, so any leaked markdown
// (**bold**, ## headings, `code`, [x](url)) shows as raw characters in a published post. This is
// the "kill markdown leakage" contract for social output. Pure + offline.
import { runCases, isMain } from "../_lib.mjs";
import { stripMarkdown } from "../../lib/email-template.js";

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

  return [runCases("linkedin · stripMarkdown() no-leak", cases, (c) => {
    const out = stripMarkdown(c.in);
    const leak = LEAK_PATTERNS.find((p) => p.re.test(out));
    if (leak) return { ok: false, note: `leaked ${leak.label}: "${out}"` };
    if (c.contains && !out.includes(c.contains)) return { ok: false, note: `dropped content "${c.contains}": "${out}"` };
    return { ok: true };
  })];
}

if (isMain(import.meta.url)) {
  const results = run();
  process.exit(results.some((r) => r.fail) ? 1 : 0);
}
