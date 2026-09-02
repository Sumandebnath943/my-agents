// agents/10-linkedin/slides.js
// Turns an approved LinkedIn post body into an ordered carousel outline. PURE — no LLM, no
// network, no clock, no randomness.
//
// WHY PURE, AND WHY THAT IS THE WHOLE POINT: the draft agent previews the media before you approve
// it, and the publish agent produces the media again at post time. They match today only because
// card rendering is deterministic (see the comments at 10a-draft.js:210 and 10c-post.js:60). The
// moment slide-splitting involves a model call, you approve one carousel and publish a different
// one. Everything here is therefore a function of the post text alone: same post in, byte-identical
// outline out, forever. The publish path additionally reuses the APPROVED bytes rather than
// re-deriving them, so determinism is the belt and stored bytes are the braces.
//
// WHY DECOMPOSE RATHER THAN PARAPHRASE: the agreed shape keeps the post body full-length, with the
// carousel reinforcing it. The failure mode of that shape is slides that simply replay sentences
// you already read three lines above — filler, and worth less than no carousel. So this splits the
// body into its DISTINCT claims, one per slide, each compressed to slide length: a short claim line
// plus the supporting remainder. Compression here is deterministic trimming, never rewording. It
// reuses Suman's own words, which is fine — they are his. What must never be reused is the SOURCE
// headline, which is what the gate below is for.
import { similarity } from "./card.js";
import { PROFILE } from "../../lib/profile.js";

// Slide budget. LinkedIn's own ceilings are far above anything a post like this produces (hundreds
// of pages), so these are editorial limits, not technical ones: past ~8 slides the swipe-through
// rate falls off a cliff and the deck stops being read to the end.
export const MAX_POINTS = 6;
export const MIN_POINTS = 3;

// Line markers a post uses for its own list items. Same set card.js strips, kept in sync
// deliberately: a marker that one module treats as content and the other as decoration produces
// slides whose text does not match the card's.
const MARKER = /^[\s]*(?:[0-9]{1,2}[.)]|[0-9]️?⃣|[•\-→*])\s*/;

// Lines that are never slide content: hashtag blocks, the agent signature, bare links, attribution.
const JUNK = /^#|^🤖|^via\s|^https?:\/\//i;

/** Character-budget trim. Ellipsises only when it actually overflows. */
export function clampChars(text, max) {
  const s = String(text ?? "").trim();
  if (s.length <= max) return s;
  // Prefer breaking at a word boundary — a mid-word cut reads as a rendering bug rather than a trim.
  const cut = s.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.\-—]+$/, "")}…`;
}

/**
 * The post's lines, cleaned and IN DOCUMENT ORDER, with a flag for whether each carried a list
 * marker.
 *
 * Order is the difference between this and card.js's candidateLines, which sorts by how quotable a
 * line is. A card shows one line, so best-first is right there. A carousel is read top to bottom;
 * re-ordering its points would scramble the argument.
 */
export function cleanLines(post) {
  return String(post || "")
    .split("\n")
    .map((raw) => {
      const t = raw.trim();
      const stripped = t.replace(MARKER, "").trim();
      return { text: stripped, marked: stripped !== t && !!stripped };
    })
    .filter((l) => l.text && !JUNK.test(l.text));
}

/**
 * The post's distinct points, in order.
 *
 * Three shapes show up in practice and each needs different handling:
 *   - an explicit list (the drafter often writes "1. … 2. … 3. …") — the author already did the
 *     splitting, so use their items verbatim and do not second-guess the boundaries
 *   - several short paragraphs — one paragraph is one thought
 *   - one long paragraph — fall back to sentences, because there is nothing else to cut on
 */
export function segments(post) {
  const lines = cleanLines(post);
  if (!lines.length) return [];

  const marked = lines.filter((l) => l.marked);
  if (marked.length >= 3) return marked.map((l) => l.text);

  // Paragraph mode. Rebuild blank-line groups from the ORIGINAL text: cleanLines drops empty lines,
  // which is exactly the separator we need here.
  const paras = String(post || "")
    .split(/\n\s*\n/)
    .map((p) => p.split("\n").map((l) => l.trim().replace(MARKER, "")).filter((l) => l && !JUNK.test(l)).join(" ").trim())
    .filter(Boolean);
  if (paras.length >= 3) return paras;

  // One block of prose: sentences are the only remaining seam.
  return sentences(lines.map((l) => l.text).join(" "));
}

/**
 * The post's opening line — what the reader already stopped scrolling for.
 *
 * Kept separate from segments() because of list-shaped posts. "Three things changed:" followed by
 * three numbered items yields three SEGMENTS, none of which is the opener; taking segs[0] as the
 * hook silently threw the actual first line away and opened the deck on item one.
 */
export function openingLine(post) {
  const lines = cleanLines(post);
  return lines.find((l) => l.text.length > 12 && !l.marked)?.text || lines[0]?.text || "";
}

/** Sentence split that tolerates the abbreviations and decimals a post about AI actually contains. */
export function sentences(text) {
  return String(text || "")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“'])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Compress one segment into a slide: a claim line plus the supporting remainder.
 *
 * The claim is the segment's first sentence. When that sentence is itself too long for a slide
 * headline, it breaks at the strongest internal punctuation instead of being cut mid-thought —
 * an em-dash or colon is almost always where the claim ends and the elaboration begins.
 */
/**
 * A leading clause that sets up a claim without being one: "In my work with AI-native products, …",
 * "Over the last year, …". Kept in the same family as card.js's cardScore, which already penalises
 * these openers when choosing a card line — for the same reason, arrived at the same way.
 */
const PREAMBLE = /^(?:in my (?:work|experience)[^,]{0,40}|from my [^,]{0,40}|i'?ve [^,]{0,40}|i have [^,]{0,40}|when i [^,]{0,40}|over the (?:last|past) [^,]{0,30}|after [^,]{0,30}),\s+/i;

/**
 * Drop a setup clause so the CLAIM leads.
 *
 * A slide headline that reads "In my work with AI-native products" says nothing and buries "the
 * data layer is where that control actually lives" in the supporting line underneath it. The words
 * are not invented or reordered — a prefix is removed and the next letter capitalised, so the line
 * still traces back to the post verbatim.
 */
export function stripPreamble(s) {
  const out = String(s || "").replace(PREAMBLE, "");
  if (out === s || out.length < 30) return s;
  return out[0].toUpperCase() + out.slice(1);
}

export function compress(segment, { titleMax = 74, bodyMax = 180 } = {}) {
  const s = stripPreamble(String(segment || "").trim());
  if (!s) return { title: "", body: "" };

  // titleMax is the size a claim WANTS to be, not a hard edge. The renderer shrinks text to fit
  // (pdfkit measures exactly, unlike the card's SVG estimate), so a slightly long claim costs a
  // couple of points of type — while forcing the break costs either a lost word or an absurd
  // one-word body. Past HARD the line stops being a claim and gets trimmed.
  const HARD = titleMax + 26;
  const MIN_BODY = 15;                  // shorter than this, a "body" is an orphan, not a sentence

  const parts = sentences(s);
  let title = parts[0] || s;
  let rest = parts.slice(1).join(" ").trim();

  if (title.length > titleMax) {
    // Look for a break far enough in to be a real clause boundary, not a stray comma at word three.
    const m = [...title.matchAll(/\s+[—–-]\s+|:\s+|,\s+/g)].find((x) => x.index > titleMax * 0.4 && x.index <= titleMax);
    if (m) {
      rest = `${title.slice(m.index + m[0].length).trim()} ${rest}`.trim();
      title = title.slice(0, m.index).trim();
    } else {
      // No clause boundary to cut on. Break at the last word and carry the remainder into the body
      // — but only if the remainder is a real fragment. Never ellipsise: truncation silently
      // deleted the last word of a claim ("…had a human gate…" for "…had a human gate somewhere"),
      // which reads as the slide trailing off rather than as the sentence it was. And never strand
      // a single word as the body, which is how the first fix read. When neither is good, the claim
      // simply runs a little long and the renderer sets it smaller.
      const at = title.lastIndexOf(" ", titleMax);
      const tail = at > 0 ? title.slice(at).trim() : "";
      if (at > titleMax * 0.5 && tail.length >= MIN_BODY) {
        rest = `${tail} ${rest}`.trim();
        title = title.slice(0, at).trim();
      }
    }
  }

  // Capitalise the supporting line. When it is the tail of a split claim it starts mid-sentence
  // ("and that is exactly why…"), and a lowercase opener under a headline reads as a fragment
  // someone forgot to finish. Case is the only thing changed — the words stay Suman's.
  const body = clampChars(rest, bodyMax);
  return {
    title: clampChars(title, HARD),
    body: body ? body[0].toUpperCase() + body.slice(1) : "",
  };
}

/**
 * The brand slide — always last, never optional.
 *
 * Every deck ends on the mark. It is the only slide whose content does not come from the post, so
 * it is also the only one that cannot fail the source-similarity gate, which is why it is appended
 * after gating rather than run through it.
 */
export function brandSlide() {
  return {
    kind: "brand",
    // Same strings the card already signs off with (card.js cardSvg defaults), so the carousel and
    // the card credit MIGI identically rather than drifting into two different sign-offs.
    watermark: "Created by MIGI",
    descriptor: "Suman's autonomous AI agent",
    name: PROFILE.name,
    site: PROFILE.site,
  };
}

/**
 * Build the outline.
 *
 * THE GATE: card.js only ever had to clear ONE line against the source headline. A carousel puts
 * six to nine lines under Suman's name, so a gate wired to slide one would be a loophole wearing a
 * policy's clothes — the restatement would simply move to slide three. Every slide's text is
 * checked here, and so is the document title. There is no rephrase escape hatch: this module is
 * pure, and a rewrite needs a model. A slide that cannot clear the bar is DROPPED, and if too few
 * survive the whole carousel is refused so the caller can fall back to the card or to text.
 *
 * @param {string} post          the approved post body (markdown already stripped by the caller)
 * @param {{sourceHeadline?: string, maxPoints?: number, minPoints?: number, maxSim?: number}} opts
 * @returns {{ok: boolean, slides: object[], dropped: object[], reason: string}}
 */
export function buildSlides(post, { sourceHeadline = "", maxPoints = MAX_POINTS, minPoints = MIN_POINTS, maxSim = 0.6 } = {}) {
  const segs = segments(post);
  if (!segs.length) return { ok: false, slides: [], dropped: [], reason: "post has no usable lines" };

  const sim = (t) => (sourceHeadline ? similarity(t, sourceHeadline) : 0);
  const dropped = [];

  // The hook is the post's opening — the line the reader already stopped for. Compressed, not
  // re-written, so slide one and the first line of the post agree with each other. If the opener
  // itself restates the source, fall through to the segments in order rather than abandoning: the
  // gate should cost you a line, not the whole carousel.
  const hookCandidates = [openingLine(post), ...segs].filter(Boolean);
  const hookSeg = hookCandidates.find((s) => sim(s) <= maxSim);
  if (!hookSeg) {
    return { ok: false, slides: [], dropped: segs.map((s) => ({ text: s, similarity: Number(sim(s).toFixed(2)) })), reason: "every line restates the source headline" };
  }
  const hook = compress(hookSeg, { titleMax: 90, bodyMax: 0 });

  const points = [];
  for (const seg of segs) {
    if (seg === hookSeg) continue;            // never repeat the hook as a point
    if (points.length >= maxPoints) break;
    const score = sim(seg);
    if (score > maxSim) { dropped.push({ text: seg, similarity: Number(score.toFixed(2)) }); continue; }
    const { title, body } = compress(seg);
    if (title.length < 12) continue;          // a fragment is not a point
    points.push({ kind: "point", title, body });
  }

  if (points.length < minPoints) {
    return { ok: false, slides: [], dropped, reason: `only ${points.length} usable point(s), need ${minPoints}` };
  }

  const slides = [
    { kind: "hook", title: hook.title },
    ...points.map((p, i) => ({ ...p, n: i + 1, of: points.length })),
    brandSlide(),
  ];
  return { ok: true, slides, dropped, reason: "" };
}

/**
 * The document's `title` — LinkedIn's Posts API takes `title` for a document, NOT `altText`
 * (proven by scripts/linkedin-document-spike.mjs). It is visible in the feed, so it is a published
 * surface and gets the same source-similarity treatment as a slide.
 */
export function documentTitle(post, { sourceHeadline = "", maxSim = 0.6, max = 100 } = {}) {
  // Same candidate order as the hook: the opener first. Taking segments[0] named a list-shaped
  // post after its first BULLET rather than after its own opening line.
  const candidates = [openingLine(post), ...segments(post)].filter(Boolean);
  const pick = candidates.find((s) => !sourceHeadline || similarity(s, sourceHeadline) <= maxSim);
  // Returns "" rather than inventing a title. An earlier version fell back to the string "A short
  // read", which is text that came from nowhere in the post and nowhere in the article — exactly
  // the kind of filler this module must never produce. An empty title is the caller's problem to
  // handle; a made-up one is a credibility problem on a published surface.
  return pick ? clampChars(pick, max) : "";
}

// ---- Provenance -----------------------------------------------------------------------------
// Slides cannot invent content: buildSlides only ever slices and trims sentences that are already
// in the post, and the post is written by 10a-draft.js from the article it actually read (it feeds
// the model 9000 chars of article text with "every fact, number, name and quote must come from
// it"). But "cannot" is worth nothing unasserted, so both properties below are checkable.

const squash = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * True when every word of a slide's text is present, in order, in the post it came from.
 *
 * Compared with punctuation and whitespace removed, because compression legitimately drops a
 * trailing clause, changes where a line breaks, and trims terminal punctuation — none of which
 * introduces a word the post did not contain, which is the property being asserted.
 */
export function traceableTo(text, post) {
  const needle = squash(String(text || "").replace(/…$/, ""));
  return !needle || squash(post).includes(needle);
}

/**
 * Numbers, percentages, money and years in a piece of text.
 *
 * Figures are where fabrication actually costs something. A slightly loose paraphrase of a claim is
 * a style problem; an invented "40%" under Suman's name is a credibility problem, and it is the one
 * category a reader will check.
 */
export function figuresIn(text) {
  return [...String(text || "").matchAll(/\b\d[\d,.]*\s?(?:%|percent|bn|billion|million|k\b|x\b)?/gi)]
    .map((m) => m[0].trim())
    .filter((f) => f.length > 1);
}

/**
 * Figures on a slide that do NOT appear in the source article.
 *
 * Deliberately narrow. A slide legitimately carries Suman's own framing and personal angle, which
 * are not in the article and must not be flagged — checking every claim against the article would
 * fire on exactly the sentences the post exists to contain. Only the digits are checked, and only
 * when the article was actually retrieved: `readArticle` in 10a-draft.js returns null for hosts
 * that defeat the scraper, and an unverifiable slide must not be reported as a verified one.
 *
 * @returns {Array<{slide: number, figure: string, text: string}>} empty when nothing is unsupported
 */
export function unsupportedFigures(slides, article) {
  if (!article) return [];
  const hay = squash(article);
  const out = [];
  (slides || []).forEach((s, i) => {
    const text = `${s.title || ""} ${s.body || ""}`;
    for (const f of figuresIn(text)) {
      if (!hay.includes(squash(f))) out.push({ slide: i + 1, figure: f, text: text.trim() });
    }
  });
  return out;
}
