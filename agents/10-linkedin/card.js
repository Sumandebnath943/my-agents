// agents/10-linkedin/card.js
// Turns a LinkedIn post into a branded 1200x1200 "insight card" PNG.
//
// WHY A CARD AND NOT A GENERATED PICTURE: an AI-generated illustration costs quota, renders
// inconsistently, and increasingly reads as low-effort on LinkedIn — the opposite of the
// positioning these posts exist to build. A typographic card has no copyright risk, no model
// call, no variance, and makes the feed instantly recognisable as yours.
//
// SVG is built as text and rasterised by @resvg/resvg-js — no browser, no canvas, no network.
// Text layout is done here (measure -> wrap -> shrink) because SVG has no text wrapping.
//
// FONTS: resvg uses system fonts. Design is deliberately forgiving — generous line spacing, a
// width budget under the true box, and a sans-serif stack that resolves on both the GitHub runner
// (DejaVu Sans) and Windows (Segoe UI/Arial). Substitution changes the look slightly; it never
// breaks the layout.
import { Resvg } from "@resvg/resvg-js";

export const CARD_SIZE = 1200;

// Brand — kept here so the whole look is one edit away.
export const BRAND = {
  bg: "#0E1116",
  bgAccent: "#151A22",
  ink: "#F5F3EC",
  muted: "#8A8980",
  accent: "#C6F24E",       // the dashboard's lime
  rule: "#252B35",
  font: "DejaVu Sans, Segoe UI, Helvetica Neue, Arial, sans-serif",
};

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

// Rough advance width per character at font-size 1, for a bold sans face. Good enough to wrap
// text safely: it errs slightly WIDE, so lines end up shorter than the box rather than overflowing.
const AVG_ADVANCE = 0.54;
const widthOf = (text, size) => text.length * size * AVG_ADVANCE;

/** Greedy word wrap to a pixel budget. Long unbreakable tokens get their own line. */
export function wrapText(text, size, maxWidth) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (widthOf(candidate, size) <= maxWidth || !line) line = candidate;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Choose the biggest font size at which the headline fits the available box.
 * Shrinking beats truncating: the whole point of the card is that the line is readable.
 */
export function fitText(text, { maxWidth, maxHeight, max = 78, min = 34, lineRatio = 1.28 }) {
  for (let size = max; size >= min; size -= 2) {
    const lines = wrapText(text, size, maxWidth);
    if (lines.length * size * lineRatio <= maxHeight) return { size, lines };
  }
  const lines = wrapText(text, min, maxWidth).slice(0, Math.floor(maxHeight / (min * lineRatio)));
  if (lines.length) lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[,.;:\s]+$/, "")}…`;
  return { size: min, lines };
}

/**
 * The single most quotable line of a post — what the card is built around.
 * Prefers a punchy standalone sentence; falls back to the opening line. Strips list markers,
 * hashtags and the agent signature so they never end up as the headline.
 */
export function pullQuote(post, { min = 40, max = 190 } = {}) {
  const cleaned = String(post || "")
    .split("\n")
    .map((l) => l.replace(/^[\s]*(?:[0-9]{1,2}[.)]|[0-9]️?⃣|[•\-→*])\s*/, "").trim())
    .filter((l) => l && !/^#/.test(l) && !/^🤖/.test(l) && !/^https?:\/\//.test(l))
    .join("\n");

  const sentences = cleaned
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= min && s.length <= max);

  if (!sentences.length) {
    const first = cleaned.split("\n").find((l) => l.length > 12) || cleaned;
    return first.slice(0, max).trim();
  }
  // Favour a line that makes a claim over one that merely sets the scene: prefer sentences that
  // are not questions and sit in the meatier middle of the length range.
  const scored = sentences.map((s, i) => ({
    s,
    score: (s.endsWith("?") ? -20 : 0) + (i === 0 ? 6 : 0) + Math.min(s.length, 130) / 10,
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0].s;
}

/** The card as an SVG string. Exported so the layout can be eyeballed without rasterising. */
export function cardSvg({ quote, kicker = "AI, in practice", author = "Suman Debnath", handle = "sumandebnath.com", watermark = "Created by MIGI" }) {
  const S = CARD_SIZE;
  const pad = 96;
  const boxW = S - pad * 2;
  // Centre the quote in the space between the kicker and the footer rule, rather than pinning it
  // near the top — a short quote otherwise left a large dead zone in the middle of the card.
  const TOP = 210, BOTTOM = S - 250;
  const { size, lines } = fitText(quote, { maxWidth: boxW, maxHeight: BOTTOM - TOP });
  const lineH = size * 1.28;
  const blockH = lines.length * lineH;
  const startY = (TOP + BOTTOM) / 2 - blockH / 2 + size * 0.82;

  const quoteLines = lines
    .map((l, i) => `<text x="${pad}" y="${(startY + i * lineH).toFixed(1)}" font-size="${size}" font-weight="700" fill="${BRAND.ink}" font-family="${BRAND.font}">${esc(l)}</text>`)
    .join("\n    ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${BRAND.bg}"/>
      <stop offset="100%" stop-color="${BRAND.bgAccent}"/>
    </linearGradient>
  </defs>
  <rect width="${S}" height="${S}" fill="url(#bg)"/>
  <rect x="0" y="0" width="14" height="${S}" fill="${BRAND.accent}"/>

  <text x="${pad}" y="150" font-size="26" font-weight="700" letter-spacing="3.5" fill="${BRAND.accent}" font-family="${BRAND.font}">${esc(kicker.toUpperCase())}</text>

  ${quoteLines}

  <line x1="${pad}" y1="${S - 210}" x2="${S - pad}" y2="${S - 210}" stroke="${BRAND.rule}" stroke-width="2"/>
  <text x="${pad}" y="${S - 150}" font-size="34" font-weight="700" fill="${BRAND.ink}" font-family="${BRAND.font}">${esc(author)}</text>
  <text x="${pad}" y="${S - 108}" font-size="25" fill="${BRAND.muted}" font-family="${BRAND.font}">${esc(handle)}</text>

  <!-- MIGI mark + watermark, bottom-right: attribution without shouting. Two lines, not three —
       printing "MIGI" as both a title and inside the watermark read as a duplication. -->
  <g transform="translate(${S - pad - 214}, ${S - 180})">
    <rect x="0" y="0" width="54" height="54" rx="15" fill="${BRAND.accent}"/>
    <text x="27" y="38" font-size="29" font-weight="700" fill="${BRAND.bg}" font-family="${BRAND.font}" text-anchor="middle">M</text>
    <text x="72" y="24" font-size="17" fill="${BRAND.muted}" font-family="${BRAND.font}">${esc(watermark.replace(/\s*MIGI\s*$/i, "").trim() || "Created by")}</text>
    <text x="72" y="48" font-size="22" font-weight="700" fill="${BRAND.ink}" font-family="${BRAND.font}">MIGI</text>
  </g>
</svg>`;
}

/** Rasterise a post into PNG bytes. Returns a Buffer, or null if rendering fails. */
export function renderCard(opts) {
  try {
    const svg = cardSvg(opts);
    const resvg = new Resvg(svg, {
      fitTo: { mode: "width", value: CARD_SIZE },
      font: { loadSystemFonts: true, defaultFontFamily: "DejaVu Sans" },
    });
    return resvg.render().asPng();
  } catch (e) {
    console.error("card: render failed —", e.message);
    return null;
  }
}
