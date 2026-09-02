// agents/10-linkedin/carousel.js
// Renders a slide outline (agents/10-linkedin/slides.js) into a LinkedIn document carousel — a
// multi-page square PDF, drawn natively with pdfkit.
//
// WHY NATIVE PDFKIT AND NOT PNGs-IN-A-PDF: LinkedIn's Posts API attaches a document with
// `content: { media: { id, title } }` — `title`, and there is NO altText field for documents
// (proven against the live API by scripts/linkedin-document-spike.mjs). So a deck built from
// pictures of text is unreadable to a screen reader with no way to compensate. Drawn natively,
// every slide carries a real text layer: selectable, searchable, accessible, and a fraction of the
// file size. The spike also confirmed LinkedIn accepts pdfkit's output as-is, multi-page and
// square, so this is a proven path rather than a hopeful one.
//
// WHY 1080pt SQUARE: a LinkedIn carousel renders 1:1 in feed. Using points 1:1 with the pixel
// convention keeps every measurement here directly comparable to card.js's 1200px geometry.
//
// FONTS: pdfkit's built-in Helvetica/Helvetica-Bold are embedded in the PDF itself, so output is
// identical on the GitHub runner and on Windows. This is strictly better than the card's position —
// card.js depends on resvg resolving a SYSTEM font, which substitutes differently per machine.
import PDFDocument from "pdfkit";
import { BRAND, MOON_RATIO } from "./card.js";

export const SLIDE_SIZE = 1080;
const PAD = 88;
const BAR = 20;                       // the lime spine down the left edge, as on the card
const FONT = "Helvetica", BOLD = "Helvetica-Bold";

/** Fill the whole slide with the card's background gradient, spine, and a faint brand ghost. */
function slideGround(doc, { ghost = true } = {}) {
  const S = SLIDE_SIZE;
  const grad = doc.linearGradient(0, 0, S, S);
  grad.stop(0, BRAND.bg).stop(1, BRAND.bgAccent);
  doc.rect(0, 0, S, S).fill(grad);

  // A single faint mark bottom-right, cropped by the edge — the card's backdrop reduced to its one
  // load-bearing element. The card's dot grid and orbit rings are deliberately NOT reproduced: at
  // slide scale, across six pages, they read as noise rather than texture.
  if (ghost) {
    doc.save().opacity(0.055);
    drawMark(doc, S * 0.88, S * 0.84, S * 0.30);
    doc.restore();
  }

  doc.rect(0, 0, BAR, S).fill(BRAND.accent);
}

/**
 * The MIGI mark: a lime disc with a dark half-moon bulging left, the flat edge on the centre line.
 * Same geometry as card.js's migiMark — the ratio is imported rather than retyped so the two
 * surfaces cannot drift apart.
 */
function drawMark(doc, cx, cy, r, { disc = BRAND.accent, moon = BRAND.bg } = {}) {
  const mr = r * MOON_RATIO;
  doc.circle(cx, cy, r).fill(disc);
  // pdfkit parses SVG path data, arcs included, so the half-moon is the identical path string the
  // card builds — one shape definition, two renderers.
  doc.path(`M ${cx} ${cy - mr} A ${mr} ${mr} 0 0 0 ${cx} ${cy + mr} Z`).fill(moon);
}

/**
 * Largest font size at which `text` fits the box, measured with pdfkit's own metrics.
 *
 * card.js has to ESTIMATE text width (AVG_ADVANCE) because SVG cannot measure. pdfkit can, so this
 * shrink-to-fit is exact rather than conservative — long claims stay a size or two larger than the
 * equivalent card line, and nothing overflows.
 */
function fitSize(doc, text, { font, width, height, max, min, gap = 1.22 }) {
  for (let size = max; size >= min; size -= 2) {
    doc.font(font).fontSize(size);
    if (doc.heightOfString(text, { width, lineGap: size * (gap - 1) }) <= height) return size;
  }
  return min;
}

function drawHook(doc, slide) {
  const S = SLIDE_SIZE, W = S - PAD * 2;
  slideGround(doc);

  doc.font(BOLD).fontSize(24).fillColor(BRAND.accent)
    .text("AI, IN PRACTICE", PAD, 132, { width: W, characterSpacing: 3.2 });

  const top = 236, box = S - 300 - top;
  const size = fitSize(doc, slide.title, { font: BOLD, width: W, height: box, max: 82, min: 40 });
  doc.font(BOLD).fontSize(size).fillColor(BRAND.ink)
    .text(slide.title, PAD, top, { width: W, lineGap: size * 0.22 });

  doc.font(FONT).fontSize(22).fillColor(BRAND.muted)
    .text("Swipe →", PAD, S - 150, { width: W });
}

function drawPoint(doc, slide) {
  const S = SLIDE_SIZE, W = S - PAD * 2;
  slideGround(doc);

  // A visible position counter. Without one the reader cannot tell a three-slide deck from a
  // nine-slide deck, and drop-off is worst where people cannot see how much is left.
  doc.font(BOLD).fontSize(22).fillColor(BRAND.accent)
    .text(`${String(slide.n).padStart(2, "0")} / ${String(slide.of).padStart(2, "0")}`, PAD, 132, { width: W, characterSpacing: 2 });

  const top = 230;
  const bodyH = slide.body ? 300 : 0;
  const box = S - 260 - top - bodyH;
  const size = fitSize(doc, slide.title, { font: BOLD, width: W, height: box, max: 66, min: 34 });
  doc.font(BOLD).fontSize(size).fillColor(BRAND.ink)
    .text(slide.title, PAD, top, { width: W, lineGap: size * 0.2 });

  if (slide.body) {
    // Measured against the space the TITLE actually left, not a guess. The title shrinks to fit but
    // still wraps to a variable number of lines, so a fixed body size could run past the rule on a
    // slide with a long claim and a long supporting line. Both now shrink; neither can overflow.
    doc.moveDown(0.6);
    const y = Math.min(doc.y + 14, S - 320);
    const room = (S - 168) - y;
    const bodySize = fitSize(doc, slide.body, { font: FONT, width: W, height: room, max: 28, min: 19 });
    doc.font(FONT).fontSize(bodySize).fillColor(BRAND.muted)
      .text(slide.body, PAD, y, { width: W, lineGap: bodySize * 0.28 });
  }

  doc.moveTo(PAD, S - 132).lineTo(S - PAD, S - 132).lineWidth(2).strokeColor(BRAND.rule).stroke();
}

/**
 * The brand slide — always last. The mark is the slide, not a footnote on it: roughly a third of
 * the canvas, centred, with the credit under it. This is the one page whose job is recall rather
 * than information, so it carries no post content at all.
 */
function drawBrand(doc, slide) {
  const S = SLIDE_SIZE, W = S - PAD * 2;
  slideGround(doc, { ghost: false });

  drawMark(doc, S / 2, S * 0.38, S * 0.17);

  doc.font(BOLD).fontSize(46).fillColor(BRAND.ink)
    .text(slide.watermark, PAD, S * 0.60, { width: W, align: "center" });
  doc.font(FONT).fontSize(26).fillColor(BRAND.accent)
    .text(slide.descriptor, PAD, S * 0.60 + 62, { width: W, align: "center" });

  doc.moveTo(S * 0.34, S * 0.78).lineTo(S * 0.66, S * 0.78).lineWidth(2).strokeColor(BRAND.rule).stroke();

  doc.font(BOLD).fontSize(32).fillColor(BRAND.ink)
    .text(slide.name, PAD, S * 0.78 + 34, { width: W, align: "center" });
  doc.font(FONT).fontSize(24).fillColor(BRAND.muted)
    .text(slide.site, PAD, S * 0.78 + 78, { width: W, align: "center" });
}

const DRAW = { hook: drawHook, point: drawPoint, brand: drawBrand };

/**
 * Render slides to PDF bytes.
 *
 * @param {object[]} slides  from buildSlides(); the last one must be the brand slide
 * @param {{title?: string, compress?: boolean}} meta
 *   `title` lands in the PDF metadata, and is what LinkedIn shows.
 *   `compress: false` leaves the content streams readable — the only way to PROVE the text layer
 *   exists rather than assume it, since a compressed stream is opaque to any assertion. Used by the
 *   eval suite; production always ships compressed.
 * @returns {Promise<Buffer>}
 */
export function renderCarousel(slides, { title = "", compress = true } = {}) {
  return new Promise((resolve, reject) => {
    if (!Array.isArray(slides) || !slides.length) return reject(new Error("no slides to render"));

    const doc = new PDFDocument({
      size: [SLIDE_SIZE, SLIDE_SIZE],
      margin: 0,
      compress,
      info: { Title: title || "Carousel", Author: slides.at(-1)?.name || "" },
    });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    slides.forEach((slide, i) => {
      if (i) doc.addPage();
      (DRAW[slide.kind] || drawPoint)(doc, slide);
    });

    doc.end();
  });
}

/**
 * Slide one as a standalone PNG, for the Bluesky/Mastodon repurpose path.
 *
 * Those platforms cannot take a PDF, and 10c-post.js archives the card art so the same image can be
 * reused when a post is repurposed (see its `card: archived` step). A carousel must not silently
 * break that, so the hook slide is also renderable as a picture — rebuilt in SVG through the card's
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
