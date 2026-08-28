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
import { PROFILE } from "../../lib/profile.js";

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

/**
 * Stable 32-bit hash of a string. Used to vary the backdrop per post so cards are not identical,
 * while staying DETERMINISTIC — the same quote always renders the same card, which is what makes
 * the output testable and reproducible.
 */
function seedOf(str) {
  let h = 2166136261;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * Muted background artwork. Everything here sits at 3–7% opacity: enough to kill the flatness of a
 * solid fill, far too faint to compete with the quote. Built from the brand's own geometry — the
 * MIGI disc, orbit rings, a dot grid — rather than generic decoration.
 *
 * Layer order matters: grid (texture) -> rings (structure) -> ghost disc (brand) -> glow (depth).
 * A seed nudges positions so consecutive posts do not look like the same template.
 */
function backdrop(S, seed) {
  const r1 = (seed % 100) / 100;              // 0..1
  const r2 = ((seed >> 7) % 100) / 100;
  const r3 = ((seed >> 13) % 100) / 100;

  const ringCx = S * (0.74 + r1 * 0.18);      // off to the right, partly bleeding off-canvas
  const ringCy = S * (0.16 + r2 * 0.14);
  const ghostR = S * (0.30 + r3 * 0.06);
  const ghostCx = S * (0.86 + r2 * 0.06);     // bottom-right, cropped by the edge
  const ghostCy = S * (0.80 + r1 * 0.06);
  // Deliberately NOT rotated. A rotated half-moon puts its straight chord on a diagonal, and even
  // at 6% that hard edge reads as a rendering glitch rather than a watermark. Upright keeps the
  // flat edge vertical, which reads as intentional — the same way any logo watermark sits upright.

  // The ghost is the MIGI silhouette: disc minus half-moon, so the brand shape reads even at 5%.
  const gm = ghostR * 0.79;

  return `
  <defs>
    <pattern id="grid" width="46" height="46" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1.6" fill="${BRAND.accent}" opacity="0.055"/>
    </pattern>
    <radialGradient id="glow" cx="18%" cy="12%" r="62%">
      <stop offset="0%" stop-color="${BRAND.accent}" stop-opacity="0.062"/>
      <stop offset="100%" stop-color="${BRAND.accent}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="vignette" cx="50%" cy="50%" r="78%">
      <stop offset="60%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.34"/>
    </radialGradient>
  </defs>

  <rect width="${S}" height="${S}" fill="url(#grid)"/>

  <g stroke="${BRAND.accent}" fill="none" opacity="0.07">
    <circle cx="${ringCx.toFixed(0)}" cy="${ringCy.toFixed(0)}" r="${(S * 0.30).toFixed(0)}" stroke-width="2"/>
    <circle cx="${ringCx.toFixed(0)}" cy="${ringCy.toFixed(0)}" r="${(S * 0.44).toFixed(0)}" stroke-width="1.5"/>
    <circle cx="${ringCx.toFixed(0)}" cy="${ringCy.toFixed(0)}" r="${(S * 0.58).toFixed(0)}" stroke-width="1"/>
  </g>

  <g transform="translate(${ghostCx.toFixed(0)} ${ghostCy.toFixed(0)})" opacity="0.055">
    <circle cx="0" cy="0" r="${ghostR.toFixed(0)}" fill="${BRAND.accent}"/>
    <path d="M 0 ${(-gm).toFixed(0)} A ${gm.toFixed(0)} ${gm.toFixed(0)} 0 0 0 0 ${gm.toFixed(0)} Z" fill="${BRAND.bg}"/>
  </g>

  <rect width="${S}" height="${S}" fill="url(#glow)"/>
  <rect width="${S}" height="${S}" fill="url(#vignette)"/>`;
}

/**
 * The MIGI mark, drawn as vector rather than embedded as a bitmap: it stays sharp at any size,
 * adds no base64 weight, and carries no white background to clash with the dark card.
 * A lime disc with a dark half-moon bulging left — the flat edge sits on the disc's centre line.
 */
export function migiMark(x, y, size) {
  const r = size / 2;
  const cx = x + r, cy = y + r;
  const mr = r * 0.79;                       // half-moon radius, measured off the source artwork
  // Start at the top of the flat edge, sweep counter-clockwise to the bottom: bulges left.
  const moon = `M ${cx} ${cy - mr} A ${mr} ${mr} 0 0 0 ${cx} ${cy + mr} Z`;
  return `<g>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="${BRAND.accent}"/>
      <path d="${moon}" fill="${BRAND.bg}"/>
    </g>`;
}

/** The card as an SVG string. Exported so the layout can be eyeballed without rasterising. */
export function cardSvg({
  quote,
  kicker = "AI, in practice",
  // Both come from lib/profile.js — never retyped here. An earlier version hardcoded a domain
  // that does not exist, and it went onto a rendered card before anyone noticed.
  author = PROFILE.name,
  handle = PROFILE.site,
  watermark = "Created by MIGI",
  // Says what MIGI actually is, so the credit informs rather than just labelling.
  descriptor = "Suman's autonomous AI agent",
}) {
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
  ${backdrop(S, seedOf(quote))}
  <rect x="0" y="0" width="14" height="${S}" fill="${BRAND.accent}"/>

  <text x="${pad}" y="150" font-size="26" font-weight="700" letter-spacing="3.5" fill="${BRAND.accent}" font-family="${BRAND.font}">${esc(kicker.toUpperCase())}</text>

  ${quoteLines}

  <line x1="${pad}" y1="${S - 210}" x2="${S - pad}" y2="${S - 210}" stroke="${BRAND.rule}" stroke-width="2"/>
  <text x="${pad}" y="${S - 150}" font-size="34" font-weight="700" fill="${BRAND.ink}" font-family="${BRAND.font}">${esc(author)}</text>
  <text x="${pad}" y="${S - 108}" font-size="25" fill="${BRAND.muted}" font-family="${BRAND.font}">${esc(handle)}</text>

  <!-- MIGI mark + credit, bottom-right. Text is right-aligned to the padding edge so a longer
       descriptor can never collide with the author block on the left. -->
  <g transform="translate(0, ${S - 182})">
    ${migiMark(S - pad - 300, 2, 52)}
    <text x="${S - pad}" y="26" font-size="22" font-weight="700" fill="${BRAND.ink}" font-family="${BRAND.font}" text-anchor="end">${esc(watermark)}</text>
    <text x="${S - pad}" y="50" font-size="17" fill="${BRAND.muted}" font-family="${BRAND.font}" text-anchor="end">${esc(descriptor)}</text>
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
