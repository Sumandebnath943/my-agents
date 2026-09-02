// evals/linkedin-slides/run.mjs
// Guards the carousel outline (agents/10-linkedin/slides.js) and the PDF renderer
// (agents/10-linkedin/carousel.js). Pure + offline — no LLM, no network, no secrets.
//
// Four contracts are enforced here, each because breaking it costs something real:
//   1. ORDER — a carousel is read top to bottom. Re-ordered points scramble the argument.
//   2. THE BRAND SLIDE IS ALWAYS LAST, on every shape of input, including degenerate ones.
//   3. THE SOURCE-SIMILARITY GATE RUNS PER SLIDE. The card only ever had to clear one line; a gate
//      wired to slide one would just move the restatement to slide three.
//   4. DETERMINISM — the draft agent previews the deck and the publish agent rebuilds it. If the
//      same post can produce two different outlines, you approve one carousel and publish another.
import { runCases, isMain } from "../_lib.mjs";
import { buildSlides, segments, compress, clampChars, openingLine, documentTitle, brandSlide, traceableTo, unsupportedFigures } from "../../agents/10-linkedin/slides.js";
import { renderCarousel, hookPng } from "../../agents/10-linkedin/carousel.js";

// ---- Fixtures: the shapes a real drafted post actually arrives in --------------------------
const NUMBERED = `Most teams are automating the wrong half of the job.

1. Agents are good at the work nobody wants to describe out loud.
2. The bottleneck was never generation, it was verification at scale.
3. Every system that survived contact with production had a human gate somewhere.
4. Governance has to live in the data layer, not the prompt.

#AI #Agents`;

const BULLETS = `Here is what shipping 10 AI products taught me.

- Speed is a creative advantage, not a shortcut you apologise for.
- Systems compound while one-off execution collapses at scale.
- Taste is the part that does not get automated away.
🤖 via MIGI`;

const PARAGRAPHS = `The future of AI is not about what agents can do.

It is about how we control what they do. Control is a design problem long before it is a policy problem.

In my work with AI-native products, the data layer is where that control actually lives. Prompts are advisory. Schemas are not.

Every team learns this the same expensive way.`;

const ONE_BLOB = `Most AI rollouts stall at the same place. The demo works and the deployment does not. That gap is not a model problem, it is an operations problem. Teams buy capability and then discover they needed verification. The fix is boring and it is structural.`;

const SOURCE = "When agents act on their own, governance has to live in the data layer";

// A post whose every line is a reworded version of the source headline — the 2026-08-28 case that
// produced the attribution policy in the first place, scaled up to a whole deck.
const ALL_RESTATE = `When agents act autonomously, governance has to live in the data layer.

Governance must live in the data layer once agents act on their own.

If agents act independently, the data layer is where governance belongs.`;

// A good post with ONE point that restates the source, buried in the middle. This is the actual
// loophole test: a gate wired to slide one lets this through, because slide one is clean.
const ONE_BAD_POINT = `Most teams are automating the wrong half of the job.

1. Agents are good at the work nobody wants to describe out loud.
2. When agents act on their own, governance has to live in the data layer.
3. Every system that survived contact with production had a human gate somewhere.
4. The bottleneck was never generation, it was verification at scale.`;

const EMPTY = `#AI #Agents\n🤖 via MIGI\nhttps://example.com/story`;

const deck = (post, source = "") => buildSlides(post, { sourceHeadline: source });

/**
 * Every string in an uncompressed PDF, concatenated — a deliberately crude text extractor. Enough
 * to answer the one question asked of it ("are these glyphs in the file as text?") without adding a
 * PDF-parsing dependency for a single assertion.
 *
 * BOTH string forms are handled. pdfkit writes its text as HEX strings inside TJ arrays
 * (`[<4d6f7374> 40 <207465616d73>] TJ`), not as `(literal) Tj` — a reader that only understood
 * parentheses concluded the text layer was missing when it was sitting right there.
 */
function pdfText(buf) {
  const s = buf.toString("latin1");
  let out = "";
  for (const m of s.matchAll(/\((?:\\[\s\S]|[^()\\])*\)|<([0-9A-Fa-f\s]{2,})>/g)) {
    if (m[1] !== undefined) {
      const hex = m[1].replace(/\s+/g, "");
      if (hex.length % 2) continue;
      out += Buffer.from(hex, "hex").toString("latin1");
    } else {
      out += m[0].slice(1, -1).replace(/\\([()\\])/g, "$1");
    }
  }
  return out;
}

export async function run() {
  // Render every good deck up front so the sync checks below can assert on real bytes.
  const rendered = {};
  for (const [id, post] of [["numbered", NUMBERED], ["bullets", BULLETS], ["paragraphs", PARAGRAPHS], ["blob", ONE_BLOB]]) {
    const d = deck(post);
    rendered[id] = d.ok ? await renderCarousel(d.slides, { title: documentTitle(post) }) : null;
  }
  const hookImage = await hookPng(deck(NUMBERED).slides);

  // An UNCOMPRESSED render of the same deck. This is the only way to prove the text layer is real:
  // in a normal (compressed) PDF the content streams are opaque, so "it has selectable text" would
  // be an assumption. Native pdfkit drawing over PNG slides was chosen specifically because
  // LinkedIn documents have no altText field — if the text layer ever silently became images, the
  // accessibility argument for the whole design would be gone with no other signal.
  const readable = await renderCarousel(deck(NUMBERED).slides, { compress: false });

  // ---- Outline shape ----------------------------------------------------------------------
  const shape = [
    { id: "numbered-splits",    post: NUMBERED,   minSlides: 5 },
    { id: "bullets-splits",     post: BULLETS,    minSlides: 5 },
    { id: "paragraphs-splits",  post: PARAGRAPHS, minSlides: 5 },
    { id: "one-blob-splits",    post: ONE_BLOB,   minSlides: 5 },
  ];

  const r1 = runCases("linkedin-slides · builds a deck from every post shape", shape, (c) => {
    const d = deck(c.post);
    if (!d.ok) return { ok: false, note: `refused: ${d.reason}` };
    if (d.slides.length < c.minSlides) return { ok: false, note: `only ${d.slides.length} slides` };
    if (d.slides[0].kind !== "hook") return { ok: false, note: `first slide is ${d.slides[0].kind}, not hook` };
    if (d.slides.at(-1).kind !== "brand") return { ok: false, note: "last slide is not the brand slide" };
    const points = d.slides.filter((s) => s.kind === "point");
    if (points.length > 6) return { ok: false, note: `${points.length} points exceeds the budget of 6` };
    if (points.some((p) => !p.title)) return { ok: false, note: "a point slide has no title" };
    return { ok: true };
  });

  // ---- The brand slide is non-negotiable ---------------------------------------------------
  const r2 = runCases("linkedin-slides · brand slide always closes the deck", [
    { id: "numbered",   post: NUMBERED },
    { id: "bullets",    post: BULLETS },
    { id: "paragraphs", post: PARAGRAPHS },
    { id: "blob",       post: ONE_BLOB },
  ], (c) => {
    const d = deck(c.post);
    const last = d.slides.at(-1);
    if (!d.ok) return { ok: false, note: `refused: ${d.reason}` };
    if (last.kind !== "brand") return { ok: false, note: `ends on ${last.kind}` };
    if (!last.watermark?.includes("MIGI")) return { ok: false, note: "brand slide does not credit MIGI" };
    if (!last.name || !last.site) return { ok: false, note: "brand slide missing name/site" };
    // Exactly one, and only at the end — a mark on every slide would be a watermark, not a close.
    const brands = d.slides.filter((s) => s.kind === "brand");
    if (brands.length !== 1) return { ok: false, note: `${brands.length} brand slides` };
    return { ok: true };
  });

  // ---- Reading order is preserved ----------------------------------------------------------
  const r3 = runCases("linkedin-slides · point order matches the post", [
    { id: "numbered-order", post: NUMBERED, expect: ["Agents are good", "The bottleneck", "Every system", "Governance has to live"] },
    { id: "bullets-order",  post: BULLETS,  expect: ["Speed is a creative", "Systems compound", "Taste is the part"] },
  ], (c) => {
    const points = deck(c.post).slides.filter((s) => s.kind === "point");
    for (const [i, fragment] of c.expect.entries()) {
      if (!points[i]) return { ok: false, note: `no slide at position ${i + 1}` };
      const text = `${points[i].title} ${points[i].body}`;
      if (!text.includes(fragment)) return { ok: false, note: `slide ${i + 1} is "${points[i].title}", expected to contain "${fragment}"` };
    }
    // Counters must agree with position, or the reader sees "03 / 04" on the second slide.
    if (points.some((p, i) => p.n !== i + 1 || p.of !== points.length)) return { ok: false, note: "slide counters do not match positions" };
    return { ok: true };
  });

  // ---- The gate runs on EVERY slide, not just the first -------------------------------------
  const r4 = runCases("linkedin-slides · source-similarity gate is per slide", [
    {
      id: "restating-middle-point-dropped",
      check: () => {
        // THE loophole case. Slide one is clean, so a gate that only checked the hook would pass
        // this deck with the source headline sitting on slide three under Suman's name.
        const open = deck(ONE_BAD_POINT);
        const gated = deck(ONE_BAD_POINT, SOURCE);
        if (!open.ok) return { ok: false, note: "ungated deck refused — fixture is wrong" };
        if (!open.slides.some((s) => /governance has to live/i.test(s.title || ""))) {
          return { ok: false, note: "fixture never carried the offending line in the first place" };
        }
        if (!gated.ok) return { ok: false, note: `whole deck refused over one bad point: ${gated.reason}` };
        if (gated.slides.some((s) => /governance has to live/i.test(`${s.title} ${s.body}`))) {
          return { ok: false, note: "the source headline survived onto a slide" };
        }
        if (!gated.dropped.length) return { ok: false, note: "line vanished without being recorded as dropped" };
        return { ok: true };
      },
    },
    {
      id: "every-line-restates-refuses",
      check: () => {
        const d = deck(ALL_RESTATE, SOURCE);
        if (d.ok) return { ok: false, note: `built a deck whose every line restates the source: "${d.slides[1]?.title}"` };
        return { ok: true };
      },
    },
    {
      id: "no-source-nothing-dropped",
      check: () => {
        const d = deck(NUMBERED, "");
        if (!d.ok) return { ok: false, note: `refused: ${d.reason}` };
        if (d.dropped.length) return { ok: false, note: "dropped slides with no source headline to compare against" };
        return { ok: true };
      },
    },
    {
      id: "document-title-gated",
      check: () => {
        const t = documentTitle(ALL_RESTATE, { sourceHeadline: SOURCE });
        if (/governance/i.test(t) && /data layer/i.test(t)) return { ok: false, note: `title restates the source: "${t}"` };
        // "" is the correct answer when no line clears the bar. The alternative is inventing one,
        // which is what the old "A short read" fallback did — and the title is a surface LinkedIn
        // renders in the feed, so a made-up one is a published claim from nowhere.
        return { ok: true };
      },
    },
  ], (c) => c.check());

  // ---- Provenance: nothing on a slide came from anywhere but the post ------------------------
  // The splitter physically cannot invent content — it only slices and trims sentences already in
  // the post — but "cannot" is worth nothing unasserted. The post itself is written by 10a-draft.js
  // from the article it actually read, under an explicit "every fact, number, name and quote must
  // come from it" instruction, so post-traceability is the last link in the chain from article to
  // slide.
  const r5b = runCases("linkedin-slides · every slide traces back to the post", [
    { id: "numbered",   post: NUMBERED },
    { id: "bullets",    post: BULLETS },
    { id: "paragraphs", post: PARAGRAPHS },
    { id: "blob",       post: ONE_BLOB },
  ], (c) => {
    const d = deck(c.post);
    for (const s of d.slides) {
      if (s.kind === "brand") continue;          // brand furniture, deliberately not post content
      for (const part of [s.title, s.body]) {
        if (part && !traceableTo(part, c.post)) {
          return { ok: false, note: `slide text is not in the post: "${part}"` };
        }
      }
    }
    return { ok: true };
  });

  const r5c = runCases("linkedin-slides · invents nothing, flags unsupported figures", [
    {
      id: "no-invented-title",
      check: () => {
        // documentTitle used to fall back to the literal string "A short read" — words from nowhere
        // in the post and nowhere in the article, on a surface LinkedIn shows in the feed.
        const t = documentTitle(EMPTY);
        if (t && !traceableTo(t, EMPTY)) return { ok: false, note: `invented a title: "${t}"` };
        return { ok: true };
      },
    },
    {
      id: "figure-in-article-passes",
      check: () => {
        const post = "Adoption jumped 40% last quarter.\n\nThat is the number that matters.\n\nEverything else is noise.\n\nThe gap is structural.";
        const article = "The report found adoption jumped 40% last quarter across surveyed teams.";
        const bad = unsupportedFigures(deck(post).slides, article);
        return bad.length ? { ok: false, note: `flagged a figure the article contains: ${JSON.stringify(bad)}` } : { ok: true };
      },
    },
    {
      id: "figure-not-in-article-flagged",
      check: () => {
        const post = "Adoption jumped 87% last quarter.\n\nThat is the number that matters.\n\nEverything else is noise.\n\nThe gap is structural.";
        const article = "The report found adoption jumped 40% last quarter across surveyed teams.";
        const bad = unsupportedFigures(deck(post).slides, article);
        return bad.some((b) => b.figure.includes("87"))
          ? { ok: true }
          : { ok: false, note: "an 87% that appears nowhere in the article was not flagged" };
      },
    },
    {
      id: "no-article-no-false-claims",
      check: () => {
        // readArticle returns null for hosts that defeat the scraper. An unverifiable deck must not
        // be reported as a verified one, so with no article there is nothing to say.
        const bad = unsupportedFigures(deck(NUMBERED).slides, null);
        return bad.length === 0 ? { ok: true } : { ok: false, note: "claimed a verdict with no article to check against" };
      },
    },
  ], (c) => c.check());

  // ---- Degenerate input refuses cleanly rather than shipping a bad deck ---------------------
  const r5 = runCases("linkedin-slides · refuses rather than shipping filler", [
    { id: "empty-post",      post: "" },
    { id: "hashtags-only",   post: EMPTY },
    { id: "single-sentence", post: "Agents are here." },
    { id: "two-points-only", post: "One real claim about systems.\n\nA second real claim here." },
  ], (c) => {
    const d = deck(c.post);
    if (d.ok) return { ok: false, note: `built a ${d.slides.length}-slide deck from nothing usable` };
    if (!d.reason) return { ok: false, note: "refused without saying why" };
    return { ok: true };
  });

  // ---- Determinism -------------------------------------------------------------------------
  const r6 = runCases("linkedin-slides · same post, byte-identical outline", [
    { id: "numbered",   post: NUMBERED },
    { id: "paragraphs", post: PARAGRAPHS },
    { id: "gated",      post: PARAGRAPHS, source: SOURCE },
  ], (c) => {
    const a = JSON.stringify(buildSlides(c.post, { sourceHeadline: c.source || "" }));
    const b = JSON.stringify(buildSlides(c.post, { sourceHeadline: c.source || "" }));
    return a === b ? { ok: true } : { ok: false, note: "two calls produced different outlines" };
  });

  // ---- Compression helpers -----------------------------------------------------------------
  const r7 = runCases("linkedin-slides · compression keeps claims intact", [
    {
      id: "long-sentence-breaks-at-dash",
      check: () => {
        const { title, body } = compress("Speed is a creative advantage and not a shortcut you apologise for — the teams that ship weekly simply learn faster than the ones that ship quarterly.");
        if (title.length > 74) return { ok: false, note: `title ${title.length} chars` };
        if (title.endsWith("…")) return { ok: false, note: `truncated instead of breaking cleanly: "${title}"` };
        if (!body) return { ok: false, note: "remainder was discarded rather than moved to the body" };
        return { ok: true };
      },
    },
    {
      id: "no-lost-words-no-orphan-body",
      check: () => {
        // A claim with no internal punctuation, just over the target length. It must keep every
        // word AND not push a single trailing word into the body.
        const src = "Every system that survived contact with production had a human gate somewhere.";
        const { title, body } = compress(src);
        if (title.endsWith("…")) return { ok: false, note: `ellipsised a claim: "${title}"` };
        if (body && body.split(/\s+/).length < 3) return { ok: false, note: `orphan body: "${body}"` };
        if (!`${title} ${body}`.includes("somewhere")) return { ok: false, note: "lost the last word of the claim" };
        if (title.length > 100) return { ok: false, note: `title ${title.length} chars, past the hard limit` };
        return { ok: true };
      },
    },
    {
      id: "preamble-does-not-become-the-headline",
      check: () => {
        // A real slide read "In my work with AI-native products" in 60pt, with the actual claim
        // demoted to the supporting line. The setup is not the point.
        const { title, body } = compress("In my work with AI-native products, the data layer is where that control actually lives. Prompts are advisory, schemas are not.");
        if (/^in my work/i.test(title)) return { ok: false, note: `headline is the setup, not the claim: "${title}"` };
        if (!/data layer/i.test(title)) return { ok: false, note: `claim did not become the headline: "${title}"` };
        if (!traceableTo(title, "In my work with AI-native products, the data layer is where that control actually lives. Prompts are advisory, schemas are not.")) {
          return { ok: false, note: `stripping the preamble broke traceability: "${title}"` };
        }
        return { ok: true, note: body ? "" : "no body (warn)" };
      },
    },
    {
      id: "preamble-strip-leaves-real-openers-alone",
      check: () => {
        // "Every system that survived…" has no setup clause to remove, and a comma later in the
        // sentence must not be mistaken for one.
        const { title } = compress("Every system that survived contact with production, without exception, had a human gate.");
        return /^every system/i.test(title) ? { ok: true } : { ok: false, note: `mangled a normal claim: "${title}"` };
      },
    },
    {
      id: "clamp-breaks-on-word",
      check: () => {
        const out = clampChars("governance has to live in the data layer rather than the prompt", 30);
        if (out.length > 30) return { ok: false, note: `${out.length} chars` };
        if (/\w…$/.test(out) && !out.includes(" ")) return { ok: false, note: `cut mid-word: "${out}"` };
        return { ok: true };
      },
    },
    {
      id: "short-text-untouched",
      check: () => {
        const out = clampChars("Agents are here.", 100);
        return out === "Agents are here." ? { ok: true } : { ok: false, note: `mangled a short string: "${out}"` };
      },
    },
    {
      id: "opening-line-not-a-list-item",
      check: () => {
        const open = openingLine(NUMBERED);
        if (/^Agents are good/.test(open)) return { ok: false, note: "took list item one as the opener" };
        if (!open.startsWith("Most teams")) return { ok: false, note: `opener is "${open}"` };
        return { ok: true };
      },
    },
    {
      id: "brand-slide-is-self-contained",
      check: () => {
        const b = brandSlide();
        return b.watermark && b.descriptor && b.name && b.site
          ? { ok: true }
          : { ok: false, note: "brand slide depends on post content" };
      },
    },
  ], (c) => c.check());

  // ---- The PDF actually renders ------------------------------------------------------------
  // Page COUNT is not asserted from the bytes: pdfkit compresses its content streams, so counting
  // page objects in the buffer is guesswork. The count is guaranteed structurally instead —
  // renderCarousel emits exactly one page per slide — and what these cases catch is a renderer that
  // throws or emits something that is not a PDF.
  const r8 = runCases("linkedin-slides · renders a valid PDF", [
    { id: "numbered-pdf",   buf: rendered.numbered },
    { id: "bullets-pdf",    buf: rendered.bullets },
    { id: "paragraphs-pdf", buf: rendered.paragraphs },
    { id: "blob-pdf",       buf: rendered.blob },
  ], (c) => {
    if (!c.buf) return { ok: false, note: "renderer returned nothing" };
    const head = c.buf.subarray(0, 5).toString("latin1");
    if (head !== "%PDF-") return { ok: false, note: `not a PDF (starts "${head}")` };
    if (!c.buf.subarray(-1024).toString("latin1").includes("%%EOF")) return { ok: false, note: "PDF has no EOF marker" };
    if (c.buf.length < 1500) return { ok: false, note: `suspiciously small: ${c.buf.length} bytes` };
    return { ok: true };
  });

  const r8b = runCases("linkedin-slides · slides carry a real text layer", [
    { id: "hook-text-present",  needle: "Most teams are automating" },
    { id: "point-text-present", needle: "verification at scale" },
    { id: "brand-text-present", needle: "MIGI" },
    { id: "author-text-present", needle: "Suman Debnath" },
    { id: "site-text-present",  needle: "sumandebnath.houseofnamus.com" },
    { id: "pill-text-present",  needle: "01 / 06" },
  ], (c) => {
    // Compared with whitespace removed on both sides. pdfkit emits a line as a TJ array split at
    // kerning pairs ("aut" -20 "omating") and starts a fresh operator at every wrapped line, so a
    // phrase is almost never one contiguous literal. Ignoring whitespace keeps the assertion about
    // the GLYPHS being present — which is what matters — rather than about pdfkit's internal
    // chunking, which is not.
    const squash = (s) => s.replace(/\s+/g, "");
    return squash(pdfText(readable)).includes(squash(c.needle))
      ? { ok: true }
      : { ok: false, note: `"${c.needle}" is not in the PDF text layer — is the slide rendering as an image?` };
  });

  const r9 = runCases("linkedin-slides · cross-post PNG still available", [
    {
      id: "hook-png-renders",
      check: () => {
        // Bluesky and Mastodon cannot take a PDF, and 10c-post.js archives card art for exactly that
        // reuse. A carousel must not quietly break the repurpose path.
        if (!hookImage) return { ok: false, note: "no PNG produced for the hook slide" };
        const sig = hookImage.subarray(1, 4).toString("latin1");
        return sig === "PNG" ? { ok: true } : { ok: false, note: `not a PNG (got "${sig}")` };
      },
    },
  ], (c) => c.check());

  return [r1, r2, r3, r4, r5, r5b, r5c, r6, r7, r8, r8b, r9];
}

if (isMain(import.meta.url)) {
  const results = await run();
  process.exit(results.some((r) => r.fail) ? 1 : 0);
}
