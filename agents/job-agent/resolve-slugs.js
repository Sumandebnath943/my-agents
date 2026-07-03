// agents/job-agent/resolve-slugs.js
// Turn company NAMES into ATS slugs automatically — no manual URL guessing.
// For each name it generates candidate slugs and probes the public Greenhouse/Lever/Ashby
// APIs; the one that returns a real board wins. Prints config-ready arrays + a table.
//
// Usage:
//   node agents/job-agent/resolve-slugs.js "OpenAI" "Anthropic" "Razorpay"
//   node agents/job-agent/resolve-slugs.js companies.txt        (one name per line)

import { readFileSync } from "node:fs";

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
async function probe(slug) {
  const [g, l, a] = await Promise.all([
    j(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`),
    j(`https://api.lever.co/v0/postings/${slug}?mode=json`),
    j(`https://api.ashbyhq.com/posting-api/job-board/${slug}`),
  ]);
  const hits = [];
  if (g && Array.isArray(g.jobs)) hits.push({ ats: "greenhouse", slug, count: g.jobs.length });
  if (Array.isArray(l)) hits.push({ ats: "lever", slug, count: l.length });
  if (a && Array.isArray(a.jobs)) hits.push({ ats: "ashby", slug, count: a.jobs.length });
  return hits;
}

async function resolve(name) {
  let best = null;
  for (const slug of candidates(name)) {
    const hits = await probe(slug);
    for (const h of hits) if (!best || h.count > best.count) best = { name, ...h };
    if (best && best.count > 0) break; // good enough — a live board with roles
  }
  return best;
}

const found = [];
const misses = [];
for (const name of names) {
  const r = await resolve(name);
  if (r) { found.push(r); console.error(`✓ ${name} -> ${r.ats}:${r.slug} (${r.count})`); }
  else { misses.push(name); console.error(`✗ ${name}`); }
}

const group = (ats) => found.filter((f) => f.ats === ats).map((f) => f.slug).sort();
console.log("\n// ---- paste into config.js ----");
console.log(`export const GREENHOUSE = ${JSON.stringify(group("greenhouse"))};`);
console.log(`export const LEVER = ${JSON.stringify(group("lever"))};`);
console.log(`export const ASHBY = ${JSON.stringify(group("ashby"))};`);
if (misses.length) console.error(`\nUnresolved (${misses.length}): ${misses.join(", ")}`);
