// agents/10-linkedin/carousel.js
// Renders a slide outline (agents/10-linkedin/slides.js) into a LinkedIn document carousel — a
// multi-page square PDF, drawn natively with pdfkit.
//
// WHY NATIVE PDFKIT AND NOT PNGs-IN-A-PDF: LinkedIn's Posts API attaches a document with
// `content: { media: { id, title } }` — `title`, and there is NO altText field for documents
// (proven against the live API by scripts/linkedin-document-spike.mjs). So a deck built from
// pictures of text is unreadable to a screen reader with no way to compensate. Drawn natively,
// every slide carries a real text layer: selectable, searchable, accessible, and a fraction of the
// file size.
//
// WHY 1080pt SQUARE: a LinkedIn carousel renders 1:1 in feed.
//
// FONTS: pdfkit's built-in Helvetica/Helvetica-Bold are embedded in the PDF, so output is identical
// on the GitHub runner and on Windows. Strictly better than the card's position — card.js depends
// on resvg resolving a SYSTEM font, which substitutes differently per machine. The cost is exactly
// two weights, so hierarchy here is built from size, colour, case and letterspacing rather than
// from six font files.
//
// DESIGN INTENT: this deck has to survive a thumb moving at speed. That means one loud thing per
// slide and a lot of quiet around it — not more decoration. Three rules hold the whole thing
// together:
//   1. ONE accent colour. Lime appears on the logo, the eyebrow, the rule and the pill, and
//      nowhere else. The moment a second colour earns a place, the accent stops meaning anything.
//   2. A fixed frame. Header and footer sit at the same y on every slide, so only the middle
//      changes as you swipe — which is what makes the deck feel like one object.
//   3. Variation from typography and layout, never from palette.
import PDFDocument from "pdfkit";
import { MOON_RATIO } from "./card.js";

export const SLIDE_SIZE = 1080;

// ---- Design tokens ---------------------------------------------------------------------------
// Deliberately NOT card.js's BRAND. The card is a single square that must read alone in a feed; a
// deck is eight surfaces read in sequence and wants a deeper, quieter ground so the accent can do
// the work. One primary colour, everything else neutral.
export const THEME = {
  bg0: "#090B0F",        // base — near-black, so the accent reads as light rather than paint
  bg1: "#141A23",        // gradient partner
  ink: "#F7F6F1",        // headlines
  dim: "#9BA3AF",        // supporting text
  rule: "#222A35",       // hairlines
  brand: "#C6F24E",      // THE primary. The only chromatic colour in the entire deck.
  onBrand: "#090B0F",    // text/shape sitting ON the primary
};

const PAD = 92;
const HEAD_Y = 84;                    // header baseline band
const FOOT_Y = SLIDE_SIZE - 132;      // footer band top
const BODY_TOP = 250;
const BODY_BOT = FOOT_Y - 56;
const FONT = "Helvetica", BOLD = "Helvetica-Bold";

const W = SLIDE_SIZE - PAD * 2;

// Characters WinAnsi CAN encode beyond Latin-1. Anything above U+00FF that is not in here has no
// glyph in pdfkit's built-in Helvetica and is dropped silently at render time.
const WINANSI_EXTRA = new Set([..."€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ"]);

// Typographic characters that LOOK like ASCII but are not encodable, mapped to what they mean.
const SUBSTITUTE = {
  "‐": "-", "‑": "-", "‒": "-",          // hyphen, NON-BREAKING hyphen, figure dash
  "―": "—", "′": "'", "″": '"',
  " ": " ", " ": " ", " ": " ", " ": " ",
  "​": "", "‌": "", "‍": "", "﻿": "",
  " ": " ", " ": " ",
};

/**
 * Make a string safe for pdfkit's built-in Helvetica.
 *
 * Suman's posts are full of NON-BREAKING hyphens (U+2011) — "real‑time", "built‑in", "go‑to" — which
 * WinAnsi cannot encode. pdfkit does not substitute or warn; it emits nothing, so a real slide read
 * "you get real  time visibility and a built  in audit trail" with holes where the hyphens should
 * be. Every string drawn on a slide goes through here.
 *
 * Fixing this at render time rather than in slides.js is deliberate: the outline feeds the LinkedIn
 * document title too, and that field is UTF-8 and should keep the author's real characters.
 */
export function pdfSafe(text) {
  let out = "";
  for (const ch of String(text ?? "")) {
    if (ch in SUBSTITUTE) { out += SUBSTITUTE[ch]; continue; }
    const code = ch.codePointAt(0);
    if (code <= 0xff || WINANSI_EXTRA.has(ch)) out += ch;
    // Anything else (emoji, CJK, rare punctuation) has no glyph and would render as a hole.
  }
  return out;
}

// ---- Primitives ------------------------------------------------------------------------------

/** Run `fn` at a given alpha without leaking the alpha into everything drawn afterwards. */
function faded(doc, alpha, fn) {
  doc.save().opacity(alpha);
  fn();
  doc.restore();
}

/**
 * The MIGI mark: a lime disc with a dark half-moon bulging left, flat edge on the centre line.
 * Geometry shared with card.js so the two surfaces cannot drift.
 *
 * The moon is filled with an OPAQUE ground colour rather than being punched out, because the mark
 * sits on a gradient. Reproducing it as a ghost at 5% — which an earlier version did, at a third of
 * the canvas — made the moon invisible and left what read as a giant plain circle. The mark is now
 * drawn small, sharp and at full opacity, which is the only size at which a logo is legible.
 */
function mark(doc, cx, cy, r, { ground = THEME.bg0 } = {}) {
  const mr = r * MOON_RATIO;
  doc.circle(cx, cy, r).fill(THEME.brand);
  // pdfkit parses SVG path data, arcs included, so this is the identical path string the card
  // builds — one shape definition, two renderers.
  doc.path(`M ${cx} ${cy - mr} A ${mr} ${mr} 0 0 0 ${cx} ${cy + mr} Z`).fill(ground);
}

/**
 * The MIGI silhouette as ONE compound path — disc and half-moon together, filled even-odd so the
 * moon is a hole rather than a shape painted over the disc.
 *
 * This is what makes a faint watermark possible. Painting the moon in the ground colour only works
 * while the ground is a flat known colour; over a gradient with a bloom and a dot grid it either
 * punches an opaque patch or, at low opacity, disappears entirely — which is exactly why the
 * previous background mark read as a plain circle. A hole is transparent at any opacity, so the
 * brand shape survives all the way down to 6%.
 */
function ghostMark(doc, cx, cy, r, alpha) {
  const mr = r * MOON_RATIO;
  const disc = `M ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} Z`;
  const moon = `M ${cx} ${cy - mr} A ${mr} ${mr} 0 0 0 ${cx} ${cy + mr} Z`;
  faded(doc, alpha, () => doc.path(`${disc} ${moon}`).fill(THEME.brand, "even-odd"));
}

/**
 * Mark plus wordmark. A bare disc at header size reads as a bullet point; with "MIGI" set beside it
 * the same shape reads as a logo. They travel together everywhere except the brand slide, where the
 * lockup is stacked instead.
 */
function lockup(doc, x, y, size, { color = THEME.ink } = {}) {
  const r = size / 2;
  mark(doc, x + r, y + r, r);
  doc.font(BOLD).fontSize(size * 0.62).fillColor(color)
    .text("MIGI", x + size + size * 0.36, y + size * 0.24, { lineBreak: false, characterSpacing: size * 0.055 });
}

/**
 * Background. A flat fill reads as a slide template; this reads as a surface.
 *
 * Three layers, all faint: a diagonal gradient, a sparse dot grid for texture, and one soft bloom of
 * the accent whose corner MOVES BY SLIDE INDEX — so consecutive slides are subtly different without
 * any two looking like different decks. Index-driven, not random, because this module must stay
 * deterministic: the draft preview and the published file have to be identical.
 */
function ground(doc, i, { watermark = true } = {}) {
  const S = SLIDE_SIZE;
  const g = doc.linearGradient(0, 0, S, S);
  g.stop(0, THEME.bg0).stop(1, THEME.bg1);
  doc.rect(0, 0, S, S).fill(g);

  faded(doc, 0.05, () => {
    for (let x = 40; x < S; x += 64) {
      for (let y = 40; y < S; y += 64) doc.circle(x, y, 1.5).fill(THEME.brand);
    }
  });

  // Four bloom positions, cycled. Enough variety to feel alive, few enough to stay coherent.
  const spots = [[0.14, 0.10], [0.88, 0.16], [0.10, 0.86], [0.90, 0.82]];
  const [fx, fy] = spots[i % spots.length];
  const bx = S * fx, by = S * fy;
  const bloom = doc.radialGradient(bx, by, 0, bx, by, S * 0.62);
  bloom.stop(0, THEME.brand, 0.11).stop(1, THEME.brand, 0);
  doc.rect(0, 0, S, S).fill(bloom);

  // The brand watermark: the MIGI silhouette, large and cropped by the right edge, sitting behind
  // everything. Anchored rather than cycled — a watermark that moves is not a watermark. A soft
  // bloom centred on it lifts it off the ground so it reads as diffused light rather than as a
  // sticker at low opacity.
  if (watermark) {
    const cx = S * 1.02, cy = S * 0.72, r = S * 0.42;
    const halo = doc.radialGradient(cx, cy, r * 0.2, cx, cy, r * 1.5);
    halo.stop(0, THEME.brand, 0.07).stop(1, THEME.brand, 0);
    doc.rect(0, 0, S, S).fill(halo);
    ghostMark(doc, cx, cy, r, 0.075);
  }
}

/** Header: logo lockup left, section label right. Identical y on every slide. */
function header(doc, label) {
  lockup(doc, PAD, HEAD_Y, 42);
  if (label) {
    doc.font(BOLD).fontSize(15).fillColor(THEME.dim)
      .text(label.toUpperCase(), PAD, HEAD_Y + 14, { width: W, align: "right", characterSpacing: 2.4, lineBreak: false });
  }
  faded(doc, 0.55, () => {
    doc.moveTo(PAD, HEAD_Y + 66).lineTo(SLIDE_SIZE - PAD, HEAD_Y + 66).lineWidth(1).strokeColor(THEME.rule).stroke();
  });
}

/**
 * The progression pill: a capsule carrying the position, with a segmented track under it.
 *
 * Present on every slide because its job is to tell a reader how much is left — the single biggest
 * lever on whether a deck gets swiped to the end. A counter that appeared only on some slides would
 * answer that question intermittently, which is worse than not answering it.
 */
function pill(doc, n, total) {
  const label = `${String(n).padStart(2, "0")} / ${String(total).padStart(2, "0")}`;
  // characterSpacing is a TEXT option in pdfkit, not a document mode — it has to be passed to the
  // measurement too, or the capsule is sized for tighter text than it ends up holding.
  doc.font(BOLD).fontSize(15);
  const tw = doc.widthOfString(label, { characterSpacing: 1.8 });
  const h = 40, w = Math.max(112, tw + 42);
  const x = SLIDE_SIZE - PAD - w, y = FOOT_Y + 2;

  // SOLID, not outlined. A thin lime outline around small lime text is two hairlines saying the
  // same thing, and at feed scale it disintegrates. Filled, the capsule is one confident shape and
  // the numbers sit on it in the ground colour at full contrast.
  doc.roundedRect(x, y, w, h, h / 2).fill(THEME.brand);
  doc.font(BOLD).fontSize(15).fillColor(THEME.onBrand)
    .text(label, x, y + 13, { width: w, align: "center", characterSpacing: 1.8, lineBreak: false });

  // ONE continuous track, exactly the capsule's width and directly under it, rather than a row of
  // separate ticks. The segmented version scattered six small dashes of two different colours below
  // an outlined pill — three competing elements in a 130px box, which read as debris rather than as
  // progress. A single bar with a filled portion says the same thing in one shape.
  const ty = y + h + 12, tr = 3;
  faded(doc, 0.28, () => doc.roundedRect(x, ty, w, tr * 2, tr).fill(THEME.dim));
  doc.roundedRect(x, ty, Math.max(tr * 2, (w * n) / total), tr * 2, tr).fill(THEME.brand);
}

/** Footer: who this is, and where you are in the deck. */
function footer(doc, { name, site, n, total }) {
  faded(doc, 0.55, () => {
    doc.moveTo(PAD, FOOT_Y - 26).lineTo(SLIDE_SIZE - PAD, FOOT_Y - 26).lineWidth(1).strokeColor(THEME.rule).stroke();
  });
  if (name) {
    doc.font(BOLD).fontSize(17).fillColor(THEME.ink).text(name, PAD, FOOT_Y + 10, { lineBreak: false });
    doc.font(FONT).fontSize(14).fillColor(THEME.dim).text(site || "", PAD, FOOT_Y + 33, { lineBreak: false });
  }
  pill(doc, n, total);
}

/**
 * Largest size at which `text` fits the box, measured with pdfkit's own metrics.
 * card.js has to ESTIMATE width (AVG_ADVANCE) because SVG cannot measure; pdfkit can, so this is
 * exact rather than conservative and headlines stay a size or two larger than the card's.
 */
function fitSize(doc, text, { font, width, height, max, min, ratio = LEAD.head }) {
  for (let size = max; size >= min; size -= 2) {
    doc.font(font).fontSize(size);
    if (doc.heightOfString(text, { width, lineGap: size * ratio }) <= height) return size;
  }
  return min;
}

/**
 * Leading, as a multiple of the type size ADDED to pdfkit's natural line height (~1.15em).
 *
 * Display type wants tighter leading than body copy — at 1.15em a four-line headline stops reading
 * as one sentence and starts reading as four separate lines, which is exactly how the first version
 * looked. Negative closes it up; the body line stays open.
 */
const LEAD = { head: -0.1, body: 0.32 };

/**
 * Draw a headline (and optional supporting line) as ONE block, vertically centred in the space
 * between the header and the footer.
 *
 * Top-aligning the content left the bottom 40% of every point slide empty — the deck read as a
 * template with the text poured into the first slot rather than as a designed page. Centring the
 * whole block, measured after the type has been fitted, is what makes short claims and long claims
 * sit equally well on the same frame.
 *
 * @returns {number} the y at which the block ends, for anything that draws relative to it
 */
function centredBlock(doc, { title, body, left, width, top, bottom, titleMax, titleMin, lead = 0 }) {
  const avail = bottom - top;
  const gap = body ? 30 : 0;
  // `lead` reserves height ABOVE the headline for something that belongs to the group — the point
  // numeral. Excluded from the centring, the numeral hung above a correctly-centred block and the
  // whole slide read top-heavy: the eye groups the numeral with the claim whether the maths does or
  // not.

  const ts = fitSize(doc, title, { font: BOLD, width, height: avail - (body ? 150 : 0), max: titleMax, min: titleMin });
  doc.font(BOLD).fontSize(ts);
  const th = doc.heightOfString(title, { width, lineGap: ts * LEAD.head });

  let bs = 0, bh = 0;
  if (body) {
    bs = fitSize(doc, body, { font: FONT, width, height: Math.max(60, avail - th - gap), max: 27, min: 18, ratio: LEAD.body });
    doc.font(FONT).fontSize(bs);
    bh = doc.heightOfString(body, { width, lineGap: bs * LEAD.body });
  }

  const y = top + Math.max(0, (avail - (lead + th + gap + bh)) / 2) + lead;

  doc.font(BOLD).fontSize(ts).fillColor(THEME.ink)
    .text(title, left, y, { width, lineGap: ts * LEAD.head });

  if (body) {
    doc.font(FONT).fontSize(bs).fillColor(THEME.dim)
      .text(body, left, y + th + gap, { width, lineGap: bs * LEAD.body });
  }

  return { top: y, bottom: y + th + gap + bh, titleBottom: y + th };
}

/** Small caps eyebrow — the quiet line that sets up the loud one. */
function eyebrow(doc, text, y) {
  doc.font(BOLD).fontSize(16).fillColor(THEME.brand)
    .text(String(text).toUpperCase(), PAD, y, { width: W, characterSpacing: 3.4, lineBreak: false });
}

// ---- Slide types -----------------------------------------------------------------------------

function drawHook(doc, slide, ctx) {
  ground(doc, ctx.i);
  header(doc, ctx.kicker);

  // The hook reserves room above and below the headline for the eyebrow and the swipe cue, then
  // centres the headline in what is left — so the three elements read as one centred group.
  const blk = centredBlock(doc, {
    title: slide.title, left: PAD, width: W,
    top: BODY_TOP + 6, bottom: BODY_BOT - 60,
    titleMax: 96, titleMin: 44,
  });

  eyebrow(doc, "Start here", blk.top - 46);

  // A short accent rule under the headline. Reads as an underline on the claim rather than as
  // another divider — the frame already has two of those.
  doc.rect(PAD, blk.bottom + 34, 96, 5).fill(THEME.brand);
  doc.font(BOLD).fontSize(17).fillColor(THEME.dim)
    .text("SWIPE", PAD, blk.bottom + 62, { characterSpacing: 3.2, lineBreak: false });
}

/**
 * Point slides, in two alternating treatments.
 *
 * Variation is the difference between a deck and a slideshow: six identically-composed slides train
 * the eye to stop reading by slide three. Both treatments use the same frame, the same type ramp and
 * the same single accent — only the emphasis moves. Chosen by index, so it stays deterministic.
 */
function drawPoint(doc, slide, ctx) {
  ground(doc, ctx.i);
  header(doc, ctx.kicker);

  const variantA = slide.n % 2 === 1;
  const left = variantA ? PAD : PAD + 36;
  const width = variantA ? W : W - 36;

  const NUMERAL = 104;
  const blk = centredBlock(doc, {
    title: slide.title, body: slide.body, left, width,
    top: BODY_TOP, bottom: BODY_BOT,
    titleMax: 68, titleMin: 32,
    lead: NUMERAL,
  });

  // EVERY point slide is numbered. The numeral used to belong to variant A only, so the count
  // disappeared on alternating slides — the reader lost their place, and the deck read as if two
  // different templates had been mixed. Numbering is information; variation is the accent bar.
  //
  // Outlined rather than filled at low opacity: lime loses its identity the moment it is faded over
  // near-black and comes out a muddy olive. An outline keeps the colour at full strength while
  // still reading as furniture rather than as a headline.
  doc.font(BOLD).fontSize(74).fillColor(THEME.brand).strokeColor(THEME.brand).lineWidth(1.4);
  faded(doc, 0.75, () => {
    doc.text(String(slide.n).padStart(2, "0"), variantA ? PAD : left, blk.top - NUMERAL, {
      lineBreak: false, characterSpacing: 1, fill: false, stroke: true,
    });
  });

  if (!variantA) {
    // B keeps the accent bar as its distinguishing element, spanning the numeral and the headline
    // so the two read as one group. Drawn after the text so its height matches what the headline
    // actually occupied rather than a guess at it.
    const top = blk.top - NUMERAL + 18;
    doc.rect(PAD, top, 5, Math.max(52, blk.titleBottom - top - 8)).fill(THEME.brand);
  }
}

/**
 * The closing brand slide. Its job is recall, not information, so it carries no post content at all
 * — which also makes it the one slide that structurally cannot fail the source-similarity gate.
 * The lockup is stacked and large here; this is the one place the mark is allowed to dominate.
 */
function drawBrand(doc, slide, ctx) {
  // No background watermark here: the mark is the subject of this slide at full size and full
  // strength. A ghost of the same shape behind it would just look like a printing error.
  ground(doc, ctx.i, { watermark: false });
  header(doc, ctx.kicker);

  const S = SLIDE_SIZE;
  mark(doc, S / 2, 452, 116, { ground: THEME.bg0 });

  doc.font(BOLD).fontSize(62).fillColor(THEME.ink)
    .text("MIGI", PAD, 610, { width: W, align: "center", characterSpacing: 9 });

  doc.font(FONT).fontSize(22).fillColor(THEME.brand)
    .text(slide.descriptor, PAD, 690, { width: W, align: "center" });

  faded(doc, 0.8, () => {
    doc.moveTo(S * 0.40, 752).lineTo(S * 0.60, 752).lineWidth(1).strokeColor(THEME.rule).stroke();
  });

  // The identity, once. The header lockup and the wordmark above already say MIGI twice; a third
  // "Created by MIGI" here said nothing new, while the person whose deck this is went unnamed
  // because the footer suppresses its copy on this slide.
  doc.font(BOLD).fontSize(26).fillColor(THEME.ink)
    .text(slide.name, PAD, 780, { width: W, align: "center" });
  doc.font(FONT).fontSize(17).fillColor(THEME.dim)
    .text(slide.site, PAD, 816, { width: W, align: "center" });
}

const DRAW = { hook: drawHook, point: drawPoint, brand: drawBrand };

/**
 * Render slides to PDF bytes.
 *
 * @param {object[]} slides  from buildSlides(); the last one must be the brand slide
 * @param {{title?: string, kicker?: string, compress?: boolean}} meta
 *   `title` lands in the PDF metadata and is what LinkedIn shows in the feed.
 *   `kicker` is the header label — brand furniture, not a claim about the article.
 *   `compress: false` leaves the content streams readable, which is the only way to PROVE the text
 *   layer exists rather than assume it. Used by the eval suite; production ships compressed.
 * @returns {Promise<Buffer>}
 */
export function renderCarousel(slides, { title = "", kicker = "AI, in practice", compress = true } = {}) {
  // eslint-disable-next-line no-param-reassign -- sanitised in place below, see the note there
  return new Promise((resolve, reject) => {
    if (!Array.isArray(slides) || !slides.length) return reject(new Error("no slides to render"));

    // Sanitise ONCE, here, rather than at each draw call. Every later measurement (fitSize,
    // heightOfString, widthOfString) then measures exactly the string that gets drawn — sanitising
    // at draw time would size the type for one string and render another.
    slides = slides.map((s) => ({
      ...s,
      title: pdfSafe(s.title), body: pdfSafe(s.body),
      name: pdfSafe(s.name), site: pdfSafe(s.site), descriptor: pdfSafe(s.descriptor),
    }));
    kicker = pdfSafe(kicker);

    const brand = slides.find((s) => s.kind === "brand") || {};
    const doc = new PDFDocument({
      size: [SLIDE_SIZE, SLIDE_SIZE],
      margin: 0,
      compress,
      info: { Title: title || "Carousel", Author: brand.name || "" },
    });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const total = slides.length;
    slides.forEach((slide, i) => {
      if (i) doc.addPage();
      (DRAW[slide.kind] || drawPoint)(doc, slide, { i, kicker });
      // The brand slide carries the identity centred and large, so the footer drops its copy of it
      // — printing "Suman Debnath" twice on the same slide read as an oversight, because it was.
      // The pill stays: the reader still wants to see they have reached the end.
      footer(doc, { name: slide.kind === "brand" ? "" : brand.name, site: brand.site, n: i + 1, total });
    });

    doc.end();
  });
}

/**
 * Slide one as a standalone PNG, for the Bluesky/Mastodon repurpose path.
 *
 * Those platforms cannot take a PDF, and 10c-post.js archives the card art so the same image can be
 * reused when a post is repurposed (see its `card: archived` step). A carousel must not silently
 * break that, so the hook slide is also renderable as a picture — rebuilt through the card's
 * existing resvg pipeline rather than extracted from the PDF, because rasterising a PDF would mean
 * a new dependency for one image.
 *
 * Returns null when the deck has no hook slide; the caller falls back to the ordinary card.
 */
export async function hookPng(slides) {
  const hook = slides?.find((s) => s.kind === "hook");
  if (!hook?.title) return null;
  const { renderCard } = await import("./card.js");
  return renderCard({ quote: hook.title });
}
