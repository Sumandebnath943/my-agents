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

/** Trim a single line to a pixel budget, ellipsising only if it actually overflows. */
export function clampToWidth(text, size, maxWidth) {
  const s = String(text ?? "");
  if (!s || widthOf(s, size) <= maxWidth) return s;
  const max = Math.max(1, Math.floor(maxWidth / (size * AVG_ADVANCE)) - 1);
  return `${s.slice(0, max).replace(/[\s,;:.]+$/, "")}…`;
}

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
  const best = candidateLines(post, { min, max })[0];
  if (best) return best;
  // Nothing sentence-shaped: fall back to the first substantial line so a card is still possible.
  const cleaned = String(post || "")
    .split("\n")
    .map((l) => l.replace(/^[\s]*(?:[0-9]{1,2}[.)]|[0-9]️?⃣|[•\-→*])\s*/, "").trim())
    .filter((l) => l && !/^#/.test(l) && !/^🤖/.test(l) && !/^via\s/i.test(l) && !/^https?:\/\//.test(l))
    .join("\n");
  const first = cleaned.split("\n").find((l) => l.length > 12) || cleaned;
  return first.slice(0, max).trim();
}

// Words too common to signal anything about substance. Dropped before comparing, so similarity
// measures shared MEANING rather than shared grammar.
const STOP = new Set("a an the and or but if then than that this these those to of in on at by for with from as is are was were be been being it its has have had how what when where why we you your our their they them i my me not no nor so such can could will would should may might must do does did".split(" "));

const contentWords = (s) => new Set(
  String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w))
);

/**
 * How much two lines share, 0..1, by content words and containment.
 *
 * Containment (over min) rather than Jaccard (over union) on purpose: a short headline swallowed
 * whole by a longer sentence must score HIGH, and Jaccard would dilute that to look safe.
 *
 * Calibration on the real 2026-08-28 case: VentureBeat's "When agents act on their own, governance
 * has to live in the data layer" against the card's "When agents act autonomously, governance has
 * to live in the data layer" scores ~0.9. A genuinely independent line from the same post scores
 * well under 0.4.
 */
export function similarity(a, b) {
  const A = contentWords(a), B = contentWords(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

/**
 * Every usable sentence from a post, best-first — the same scoring pullQuote uses, exposed so a
 * caller can walk past a candidate that is too close to the source.
 */
export function candidateLines(post, { min = 40, max = 190 } = {}) {
  const cleaned = String(post || "")
    .split("\n")
    .map((l) => l.replace(/^[\s]*(?:[0-9]{1,2}[.)]|[0-9]️?⃣|[•\-→*])\s*/, "").trim())
    .filter((l) => l && !/^#/.test(l) && !/^🤖/.test(l) && !/^via\s/i.test(l) && !/^https?:\/\//.test(l))
    .join("\n");
  return cleaned
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= min && s.length <= max)
    .map((s, i) => ({ s, score: cardScore(s, i) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.s);
}

/**
 * How card-worthy a sentence is.
 *
 * The first version simply preferred LONGER lines, which reliably picked the wrong sentence: on a
 * real post it chose "In my work with AI-native products, I've seen how this data-layer approach
 * kept the IMPRINT engine reliable and compliant" — supporting evidence — over "The future of AI
 * isn't just about what agents can do, it's about how we control what they do", which is the
 * actual claim. A card carries the claim.
 */
function cardScore(s, i) {
  const len = s.length;
  let score = 14 - Math.abs(len - 90) / 12;              // punchy beats long; peak around 90 chars
  if (s.endsWith("?")) score -= 20;                       // a question cannot carry a card
  if (/^(in my work|from my|i'?ve|i have|when i|in my experience)/i.test(s)) score -= 12;  // evidence, not the claim
  if (/\b(isn'?t|aren'?t|not)\b.{0,45}\b(it'?s|they'?re|but)\b/i.test(s)) score += 5;      // contrast lands
  if (i === 0) score += 3;
  return score;
}

/**
 * Choose the line the card is built from, guaranteeing it is not a restatement of the source.
 *
 * Order of preference:
 *   1. the best candidate that is already sufficiently different from the source headline
 *   2. failing that, a rephrase of the best candidate — but VERIFIED, not trusted. Rewording is
 *      exactly what produced the original problem ("act on their own" -> "act autonomously" is a
 *      rephrase, and still 92% the same headline), so a rewrite that does not clear the same bar
 *      is rejected like any other candidate.
 *   3. failing that, whichever candidate is LEAST similar — unless even that restates the source
 *      (> hardMax), in which case NO card is produced and the post goes out as text.
 *
 * @param {string} post
 * @param {{sourceHeadline?: string, rephrase?: ((line:string)=>Promise<string>)|null, maxSim?: number}} opts
 *   `rephrase` is injected so this module stays pure and offline-testable; 10c-post.js supplies the
 *   real LLM-backed one.
 * @returns {Promise<{line: string, via: "original"|"rephrased"|"least-similar", similarity: number}>}
 */
export async function pickCardLine(post, { sourceHeadline = "", rephrase = null, maxSim = 0.6, hardMax = 0.8 } = {}) {
  const candidates = candidateLines(post);
  if (!candidates.length) return { line: pullQuote(post), via: "original", similarity: 0 };
  if (!sourceHeadline) return { line: candidates[0], via: "original", similarity: 0 };

  const scored = candidates.map((s) => ({ s, sim: similarity(s, sourceHeadline) }));

  const clean = scored.find((c) => c.sim <= maxSim);
  if (clean) return { line: clean.s, via: "original", similarity: Number(clean.sim.toFixed(2)) };

  if (typeof rephrase === "function") {
    try {
      const out = String(await rephrase(scored[0].s) || "").trim().replace(/^["“]|["”]$/g, "");
      const sim = similarity(out, sourceHeadline);
      if (out && out.length >= 30 && out.length <= 190 && sim <= maxSim) {
        return { line: out, via: "rephrased", similarity: Number(sim.toFixed(2)) };
      }
      console.log(`card: rephrase rejected (similarity ${sim.toFixed(2)} > ${maxSim}) — falling back`);
    } catch (e) {
      console.log("card: rephrase failed —", e.message);
    }
  }

  // Last resort: the least similar line. But if even THAT is essentially the source headline,
  // return nothing and let the caller post text-only. A missing card costs a little reach; a card
  // that puts someone else's headline in 70px type under your name costs your credibility.
  const least = scored.reduce((a, b) => (b.sim < a.sim ? b : a));
  if (least.sim > hardMax) {
    console.log(`card: SKIPPED — every candidate restates the source (best ${least.sim.toFixed(2)} > ${hardMax})`);
    return { line: null, via: "blocked", similarity: Number(least.sim.toFixed(2)) };
  }
  return { line: least.s, via: "least-similar", similarity: Number(least.sim.toFixed(2)) };
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
  // TOP-ANCHOR the quote just under the kicker, rather than centring it in the space between the
  // kicker and the footer. Centring split the empty space in two and left a conspicuous void
  // between "AI, IN PRACTICE" and the first line — it read as a gap, not as breathing room.
  // Anchored, the quote leads the card and all the whitespace pools above the footer, where it
  // looks deliberate. Long quotes still shrink to fit via fitText.
  const TOP = 254, BOTTOM = S - 250;
  const { size, lines } = fitText(quote, { maxWidth: boxW, maxHeight: BOTTOM - TOP });
  const lineH = size * 1.28;
  const startY = TOP + size * 0.82;   // first baseline; the block grows downward from here

  // Credit block geometry — measured so the mark can never be overprinted by the text beside it.
  // widthOf errs slightly WIDE, which is the safe direction here: it buys clearance rather than
  // eating into it. The bold watermark gets a small extra allowance on top.
  const creditWmSize = 22, creditDcSize = 17, creditMark = 52, creditGap = 18;
  // Floor the mark at the card's midpoint so a long descriptor can never march into the author's
  // name opposite. That floor caps how much room the text has, so CLAMP the text to it — pushing
  // the mark left is the first defence, trimming the text is the second. Without the clamp an
  // over-long descriptor simply overlapped the mark once the floor was reached.
  const creditFloor = S * 0.46;
  const creditBudget = (S - pad) - (creditFloor + creditMark + creditGap);
  const wm = clampToWidth(watermark, creditWmSize * 1.06, creditBudget);
  const dc = clampToWidth(descriptor, creditDcSize, creditBudget);
  const creditW = Math.max(widthOf(wm, creditWmSize) * 1.06, widthOf(dc, creditDcSize));
  const creditMarkX = Math.max(creditFloor, S - pad - creditW - creditGap - creditMark);

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

  <!-- MIGI mark + credit, bottom-right.
       The mark's x is MEASURED, not fixed. It used to sit at a hard-coded offset while the text
       was right-aligned to the padding edge, so "Suman's autonomous AI agent" grew leftward and
       printed straight over the logo. Measure the wider of the two lines, then place the mark
       clear of it. Any future watermark or descriptor now positions itself correctly. -->
  <g transform="translate(0, ${S - 182})">
    ${migiMark(creditMarkX, 2, creditMark)}
    <text x="${S - pad}" y="26" font-size="${creditWmSize}" font-weight="700" fill="${BRAND.ink}" font-family="${BRAND.font}" text-anchor="end">${esc(wm)}</text>
    <text x="${S - pad}" y="50" font-size="${creditDcSize}" fill="${BRAND.muted}" font-family="${BRAND.font}" text-anchor="end">${esc(dc)}</text>
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
