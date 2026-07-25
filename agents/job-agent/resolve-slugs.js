// agents/job-agent/resolve-slugs.js
// Turn company NAMES into ATS slugs automatically — no manual URL guessing.
// For each name it generates candidate slugs and probes the public Greenhouse/Lever/Ashby
// APIs; the one that returns a real board wins. Prints config-ready arrays + a table.
//
// Usage:
//   node agents/job-agent/resolve-slugs.js "OpenAI" "Anthropic" "Razorpay"
//   node agents/job-agent/resolve-slugs.js companies.txt        (one name per line)

import { readFileSync } from "node:fs";
import { classifyGeo } from "./geo.js";

const args = process.argv.slice(2);
let names = [];
if (args.length === 1 && /\.(txt|csv)$/i.test(args[0])) {
  names = readFileSync(args[0], "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean).filter((l) => !l.startsWith("#"));
} else {
  names = args;
}
names = [...new Set(names)];
if (!names.length) { console.error("Give company names or a .txt file (one per line)."); process.exit(1); }

function candidates(name) {
  const base = name.toLowerCase().trim();
  const noSuffix = base.replace(/\b(inc|llc|ltd|limited|technologies|technology|labs|software|systems|solutions|corp|company|co|the)\b/g, " ").trim();
  const out = [
    base.replace(/[^a-z0-9]+/g, ""),          // "open ai" -> "openai"
    base.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), // -> "open-ai"
    noSuffix.replace(/[^a-z0-9]+/g, ""),
    noSuffix.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
  ];
  return [...new Set(out)].filter(Boolean);
}

const j = async (url) => { try { const r = await fetch(url, { headers: { "User-Agent": "slug-resolver/1.0" } }); if (!r.ok) return null; return await r.json(); } catch { return null; } };

// A LIVE BOARD IS NOT A MATCH. Every one of these slugs is somebody's board — probing "pine" for
// "Pine Labs" returns a Canadian mortgage brokerage, "slice" returns a company in Skopje, "porter"
// returns a US healthcare staffing firm. Accepting those silently poisons the whole pipeline with
// foreign jobs, so a hit must be CONFIRMED before it can be pasted into config.js.
//
// Only Greenhouse exposes the board's company name (/v1/boards/<slug> -> {name}). Lever and Ashby
// expose nothing identifying, so their hits can never be auto-confirmed — they are reported
// separately with sample roles for a human to eyeball.
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
// Only TRUE legal suffixes are droppable here. Slug GENERATION strips more (see candidates()),
// but for MATCHING, words like "Labs", "Technologies" and "Systems" are part of the identity:
// treating them as noise is what let board "Pine" pass as "Pine Labs".
const LEGAL = /\b(inc|llc|ltd|limited|corp|corporation|company|co|pvt|private|plc|gmbh|bv|the)\b/g;
const core = (s) => norm(String(s || "").toLowerCase().replace(LEGAL, " "));

/** Do the requested company name and the board's own name refer to the same company? */
export function namesMatch(requested, boardName) {
  if (!boardName) return false;
  const a = norm(requested), b = norm(boardName);
  if (a === b) return true;
  const ca = core(requested), cb = core(boardName);
  if (ca && cb && ca === cb) return true;
  // Allow a board name that merely adds words ("Postman Inc" for "Postman") but NOT one that is a
  // bare prefix of what we asked for ("Pine" for "Pine Labs") — that is the exact false positive.
  return !!(ca && cb && cb.startsWith(ca) && cb.length > ca.length && b.length >= a.length);
}

// How many of a board's roles could an India resident actually hold? Two same-named companies
// can't be told apart by metadata (board "Slice" really is called Slice — just not the Indian one),
// but a board with zero India-reachable roles is useless for THIS search either way, so it gets
// held for review instead of being auto-confirmed.
const reachableFromIndia = (locations) =>
  locations.filter((loc) => classifyGeo({ location: loc }).eligible === true).length;

async function probe(slug) {
  const [gMeta, g, l, a] = await Promise.all([
    j(`https://boards-api.greenhouse.io/v1/boards/${slug}`),
    j(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`),
    j(`https://api.lever.co/v0/postings/${slug}?mode=json`),
    j(`https://api.ashbyhq.com/posting-api/job-board/${slug}`),
  ]);
  const hits = [];
  if (g && Array.isArray(g.jobs)) {
    hits.push({ ats: "greenhouse", slug, count: g.jobs.length, boardName: gMeta?.name || "",
      india: reachableFromIndia(g.jobs.map((x) => x.location?.name || "")),
      samples: g.jobs.slice(0, 3).map((x) => `${x.title} — ${x.location?.name || "?"}`) });
  }
  if (Array.isArray(l)) {
    hits.push({ ats: "lever", slug, count: l.length, boardName: "",
      india: reachableFromIndia(l.map((x) => x.categories?.location || "")),
      samples: l.slice(0, 3).map((x) => `${x.text} — ${x.categories?.location || "?"}`) });
  }
  if (a && Array.isArray(a.jobs)) {
    hits.push({ ats: "ashby", slug, count: a.jobs.length, boardName: "",
      india: reachableFromIndia(a.jobs.map((x) => x.location || "")),
      samples: a.jobs.slice(0, 3).map((x) => `${x.title} — ${x.location || "?"}`) });
  }
  return hits;
}

async function resolve(name) {
  const all = [];
  for (const slug of candidates(name)) {
    for (const h of await probe(slug)) {
      const named = h.ats === "greenhouse" && namesMatch(name, h.boardName);
      all.push({ name, ...h, named, confirmed: named && h.count > 0 && h.india > 0 });
    }
    if (all.some((h) => h.confirmed)) break;                  // a confirmed live board ends the search
  }
  if (!all.length) return null;
  // Prefer confirmed, then India-reachable, then non-empty, then bigger.
  all.sort((x, y) => (y.confirmed - x.confirmed) || ((y.india > 0) - (x.india > 0)) || ((y.count > 0) - (x.count > 0)) || (y.count - x.count));
  return all[0];
}

const confirmed = [];
const review = [];
const misses = [];
for (const name of names) {
  const r = await resolve(name);
  if (!r) { misses.push(name); console.error(`✗ ${name}`); continue; }
  if (r.confirmed) {
    confirmed.push(r);
    console.error(`✓ ${name} -> ${r.ats}:${r.slug} (${r.count} jobs, ${r.india} India-reachable, board "${r.boardName}")`);
  } else {
    review.push(r);
    const why = r.count === 0 ? "board is EMPTY"
      : r.ats !== "greenhouse" ? `${r.ats} exposes no company name — verify by hand`
      : !r.named ? `board is named "${r.boardName}" — not the company we asked for`
      : `board "${r.boardName}" matches the name but has NO India-reachable roles today — either a different company sharing the name, or one that simply isn't hiring here`;
    console.error(`? ${name} -> ${r.ats}:${r.slug} (${r.count}) — ${why}`);
  }
}

const group = (ats) => confirmed.filter((f) => f.ats === ats).map((f) => f.slug).sort();
console.log("\n// ---- CONFIRMED — safe to paste into config.js ----");
console.log(`export const GREENHOUSE = ${JSON.stringify(group("greenhouse"))};`);
console.log(`export const LEVER = ${JSON.stringify(group("lever"))};`);
console.log(`export const ASHBY = ${JSON.stringify(group("ashby"))};`);

if (review.length) {
  console.log(`\n// ---- NEEDS REVIEW (${review.length}) — a board exists but may be a DIFFERENT company ----`);
  console.log("// Check the sample roles; add the slug by hand only if it is really the company you meant.");
  for (const r of review) {
    console.log(`// ${r.name} -> ${r.ats}:${r.slug} (${r.count} jobs)`);
    for (const s of r.samples || []) console.log(`//     ${s}`);
  }
}
if (misses.length) console.error(`\nUnresolved (${misses.length}): ${misses.join(", ")}`);
