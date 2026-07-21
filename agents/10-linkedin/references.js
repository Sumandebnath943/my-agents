// agents/10-linkedin/references.js
// REFERENCE POSTS — the concrete exemplars the drafter imitates. This is the missing piece that
// made the agent "forget" the trained tone: voice.js holds the *rules* (HOW to write), but a model
// follows real examples far more reliably than abstract instructions. These are ground-truth posts
// Suman picked, kept verbatim in reference-posts.txt (version-controlled), that get injected into
// every draft prompt as few-shot STYLE anchors — used for CADENCE/STRUCTURE ONLY, never their
// content, claims, links, hashtags or CTAs.
//
// Because they live in the repo AND get seeded into the voice memory (npm run linkedin:seed-voice),
// the tone can't be silently wiped again. To refresh the style: edit reference-posts.txt (each post
// starts with a `RefN:` line) and re-run the seed script.
import { readFileSync } from "node:fs";

// Parse reference-posts.txt into an array of post bodies. Posts are delimited by `RefN:` headers.
// Best-effort: any read/parse failure yields an empty list so drafting never breaks.
function loadReferencePosts() {
  try {
    const raw = readFileSync(new URL("./reference-posts.txt", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    return raw
      .split(/(?:^|\n)Ref\d+:\s*\n?/) // split on "Ref1:", "Ref2:", ... headers
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export const REFERENCE_POSTS = loadReferencePosts();

// Renders the reference posts as a labelled few-shot block for the draft prompt. Returns "" when
// no references exist, so the prompt stays clean until real exemplars are added.
export function referenceBlock() {
  const posts = REFERENCE_POSTS.map((p) => String(p).trim()).filter(Boolean);
  if (!posts.length) return "";
  // Rotate a random subset each run so every exemplar gets used over time (variety of shapes),
  // while capping tokens per prompt.
  const shown = [...posts].sort(() => Math.random() - 0.5).slice(0, 8);
  return `\n\nSTYLE EXEMPLARS — these are real posts in MY voice. Match their RHYTHM, LINE-BREAK CADENCE, sentence length, hook style, and how they land a close. Imitate the FORM, never the content or claims — the subject matter must be today's news, not theirs. IGNORE any promotional CTAs, external links, @mentions, hashtags, or "follow/register/join my community" lines in these exemplars — those are NOT part of the style to copy. This cadence is non-negotiable; when in doubt, format like these:\n${shown
    .map((p, i) => `--- EXEMPLAR ${i + 1} ---\n${p}`)
    .join("\n\n")}\n--- END EXEMPLARS ---`;
}
