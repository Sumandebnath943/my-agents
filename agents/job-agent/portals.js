// agents/job-agent/portals.js — sourcing from the job PORTALS, where the Indian market actually is.
//
// WHY DISCOVERY-BY-SEARCH INSTEAD OF SCRAPING SEARCH PAGES:
// Naukri/Instahyre/Cutshort/Hirist/iimjobs/Wellfound all render their result lists with JavaScript
// behind rotating URL schemes and anti-bot checks. Hand-written listing parsers for nine portals
// would be nine things that silently break. Instead we ask Tavily (a search index) for job pages on
// a given domain, then scrape only the individual job pages we actually want. That means:
//   · no scraping of any portal's search/feed endpoints, and nothing that needs a logged-in session
//   · the URL scheme can change under us and discovery still works
//   · the expensive call (Firecrawl on a JD) happens ONLY after the free title filter has passed
//
// LINKEDIN specifically is sourced the same way — public job pages found through a search index.
// We never touch its search feed or anything requiring a session, which keeps this consistent with
// the fleet rule in agents/30-browser (no LinkedIn automation).
//
// BUDGET: Firecrawl (500/mo) and Tavily (1000/mo) are shared with the rest of the fleet, so this
// module works to a per-run allowance and ROTATES which portal×query pairs it spends it on — every
// pair comes up over a few days instead of the first N being the only ones ever searched.
import { webSearch, searchEnabled } from "../../lib/search.js";
import { scrapeClean } from "../../lib/scrape.js";
import { getState, setState } from "../../lib/store.js";
import { matchTitle } from "./filter.js";
import { classifyGeo, GEO } from "./geo.js";
import { PORTAL_QUERIES, PORTAL_SEARCHES_PER_RUN, PORTAL_JD_SCRAPES_PER_RUN } from "./config.js";

const CURSOR_KEY = "job-agent:portal_cursor";
const dayOfYear = (d = new Date()) => Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 864e5);

/**
 * The portals we source from. `id` becomes the `source` column on the jobs table.
 *
 * `indiaOnly` marks portals that serve the Indian market exclusively. It matters because a search
 * result gives us no location field — so without this hint every portal role would land in geo
 * `unknown`, get sent to LLM adjudication, and quite possibly be held back despite being an
 * India-only site. It is applied conservatively: only when the result itself names no foreign
 * place (Naukri does carry some Gulf postings).
 */
export const PORTALS = [
  { id: "naukri",         domain: "naukri.com",           label: "Naukri",       indiaOnly: true },
  { id: "instahyre",      domain: "instahyre.com",        label: "Instahyre",    indiaOnly: true },
  { id: "cutshort",       domain: "cutshort.io",          label: "Cutshort",     indiaOnly: true },
  { id: "hirist",         domain: "hirist.tech",          label: "Hirist",       indiaOnly: true },
  { id: "iimjobs",        domain: "iimjobs.com",          label: "iimjobs",      indiaOnly: true },
  { id: "wellfound",      domain: "wellfound.com",        label: "Wellfound",    indiaOnly: false },
  { id: "workatastartup", domain: "workatastartup.com",   label: "Y Combinator", indiaOnly: false },
  { id: "uplers",         domain: "ats.uplers.com",       label: "Uplers",       indiaOnly: true },
  { id: "linkedin",       domain: "linkedin.com",         label: "LinkedIn",     indiaOnly: false },
];

// A search result is only a job POSTING if its URL looks like one. Portals also publish company
// pages, blog posts and "top 10 jobs in Pune" listicles, which must never reach the scorer.
const JOB_URL_RE = {
  naukri:         /naukri\.com\/job-listings-|naukri\.com\/.+-jobs?-/i,
  instahyre:      /instahyre\.com\/(job|j)\//i,
  cutshort:       /cutshort\.io\/job\//i,
  hirist:         /hirist\.(tech|com)\/j\//i,
  iimjobs:        /iimjobs\.com\/j\//i,
  wellfound:      /wellfound\.com\/(jobs|company\/[^/]+\/jobs)\//i,
  workatastartup: /workatastartup\.com\/jobs\//i,
  uplers:         /uplers\.com\/(job|jobs)\//i,
  linkedin:       /linkedin\.com\/jobs\/view\//i,
};
// Obvious non-postings that still live on those domains.
const NOT_A_JOB_RE = /\/(blog|article|advice|career-advice|news|resources|courses|salary|companies|reviews|interview-questions)\//i;

/**
 * Pull a company name out of a search-result title. Portals format these predictably:
 *   "Senior Product Marketing Manager - Acme Technologies - Bengaluru | Naukri.com"
 *   "Acme hiring Product Marketing Manager in Pune | LinkedIn"
 * Returns "" when nothing trustworthy is found — a wrong company name is worse than none.
 */
export function extractCompany(resultTitle, portalId) {
  const t = String(resultTitle || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const linkedin = t.match(/^(.+?)\s+hiring\s+/i);          // LinkedIn's own phrasing
  if (linkedin) return clean(linkedin[1]);
  const parts = t.split(/\s+[-–—|]\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return "";
  // Drop the portal's own branding and any segment that is plainly a location or the job title.
  const junk = new RegExp(`^(${PORTALS.map((p) => p.label).join("|")}|naukri\\.com|jobs?|careers?|hiring)$`, "i");
  const candidates = parts.slice(1).filter((p) => !junk.test(p) && !matchTitle(p));
  return candidates.length ? clean(candidates[0]) : "";
}
const clean = (s) => String(s).replace(/\s*\((?:India|Remote|Hybrid)\)\s*$/i, "").replace(/[.,;]+$/, "").trim().slice(0, 80);

/** Strip the portal's branding off a result title so the title filter sees the role, not the site. */
export function cleanTitle(resultTitle, portalId) {
  let t = String(resultTitle || "").replace(/\s+/g, " ").trim();
  t = t.replace(/\s*[-–—|]\s*(naukri\.com|naukri|linkedin|instahyre|cutshort|hirist|iimjobs|wellfound|y combinator|uplers)\b.*$/i, "");
  const hiring = t.match(/\bhiring\s+(.+?)\s+in\s+/i);      // "Acme hiring <TITLE> in Pune"
  if (hiring) return hiring[1].trim();
  return t.split(/\s+[-–—|]\s+/)[0].trim();
}

/** Is this search result plausibly a live job posting on this portal? */
export function isJobResult(url, portalId) {
  const u = String(url || "");
  if (!u) return false;
  if (NOT_A_JOB_RE.test(u)) return false;
  const re = JOB_URL_RE[portalId];
  return re ? re.test(u) : false;
}

/**
 * Turn a Tavily result into a candidate job. Pure — no network, so it's eval-able.
 * @returns {object|null} null when the result isn't a usable job posting
 */
export function toCandidate(result, portal) {
  if (!result?.url || !isJobResult(result.url, portal.id)) return null;
  const title = cleanTitle(result.title, portal.id);
  if (!title) return null;
  const snippet = String(result.content || "").slice(0, 1500);

  // Give geo.js something to work with. On an India-only portal the location is India unless the
  // result itself points somewhere else (Naukri does list Gulf roles), which we check by running
  // the real classifier over the snippet rather than guessing.
  let location = "";
  if (portal.indiaOnly) {
    const fromSnippet = classifyGeo({ location: "", description: `${result.title || ""} ${snippet}` });
    if (fromSnippet.geo !== GEO.FOREIGN) location = "India";
  }

  return {
    title,
    company: extractCompany(result.title, portal.id) || "",
    location,
    url: result.url,
    apply_url: result.url,
    ats: portal.id,
    source: portal.id,
    posted_at: null,                    // search results carry no reliable posting date
    salary: "",
    description: snippet,               // the snippet, until a JD fetch replaces it
    needsJd: true,
  };
}

/** Every portal × query pair, in a stable order so the rotation cursor means something. */
export function buildPairs(portals = PORTALS, queries = PORTAL_QUERIES) {
  const pairs = [];
  for (const q of queries) for (const p of portals) pairs.push({ portal: p, query: q });
  return pairs;
}

/** Take `n` pairs starting at `cursor`, wrapping around. Pure. */
export function rotate(pairs, cursor, n) {
  if (!pairs.length || n <= 0) return { slice: [], next: cursor };
  const take = Math.min(n, pairs.length);
  const slice = Array.from({ length: take }, (_, i) => pairs[(cursor + i) % pairs.length]);
  return { slice, next: (cursor + take) % pairs.length };
}

/**
 * Source jobs from the portals.
 * Discovery is Tavily (cheap, 1000/mo); only titles that survive the free filter get a Firecrawl
 * JD fetch (expensive, 500/mo). Both degrade to nothing/plain-fetch rather than failing the run.
 */
export async function portalJobs({
  searches = PORTAL_SEARCHES_PER_RUN,
  jdScrapes = PORTAL_JD_SCRAPES_PER_RUN,
} = {}) {
  if (!searchEnabled()) {
    console.log("portals: TAVILY_API_KEY absent — skipping portal sourcing (ATS sources still run).");
    return [];
  }

  const pairs = buildPairs();
  // The cursor is an OPTIMIZATION, not a dependency: if the kv store is unreachable we still
  // rotate, just from a day-derived offset instead of a remembered one. Losing persistence must
  // not cost us portal sourcing altogether, and it must not pin every run to the same pairs.
  let cursor;
  try {
    cursor = Number(await getState(CURSOR_KEY, 0)) || 0;
  } catch (e) {
    cursor = (dayOfYear() * searches) % pairs.length;
    console.error(`portals: cursor read failed (${e.message}) — rotating from a day-derived offset instead.`);
  }
  const { slice, next } = rotate(pairs, cursor, searches);

  const seen = new Set();
  const candidates = [];
  for (const { portal, query } of slice) {
    let results = [];
    try {
      results = await webSearch(`${query} jobs in India`, { includeDomains: [portal.domain], max: 10, days: 45 });
    } catch (e) {
      console.error(`portals: search failed for ${portal.id}/"${query}" — ${e.message}`);
      continue;
    }
    for (const r of results) {
      const c = toCandidate(r, portal);
      if (!c || seen.has(c.url)) continue;
      seen.add(c.url);
      candidates.push(c);
    }
  }
  await setState(CURSOR_KEY, next).catch(() => {});
  console.log(`portals: ${slice.length} searches → ${candidates.length} candidate postings.`);

  // TWO FREE GATES BEFORE ANY PAID FETCH. Firecrawl is the scarce resource (500/mo shared with the
  // rest of the fleet), so a scrape must never be spent on a role we already know we'd reject.
  //   1. title — must be one of our target roles
  //   2. geo   — a result whose title+snippet already prove it's outside India is dropped now,
  //              rather than after paying to read the whole job description
  const onTarget = candidates.filter((c) => matchTitle(c.title));
  const worth = [];
  let preGeoDropped = 0;
  for (const c of onTarget) {
    const v = classifyGeo({ location: c.location, description: `${c.title} ${c.description}` });
    if (v.eligible === false) { preGeoDropped++; continue; }
    // Order what remains so confirmed-eligible roles get the budget before undecidable ones.
    worth.push({ c, rank: v.eligible === true ? 0 : 1 });
  }
  worth.sort((a, b) => a.rank - b.rank);
  const queue = worth.map((w) => w.c);
  console.log(`portals: ${onTarget.length} on-target, ${preGeoDropped} dropped as non-India before scraping; fetching up to ${jdScrapes} JDs.`);

  const out = [];
  for (const c of queue.slice(0, jdScrapes)) {
    let text = "";
    try {
      text = await scrapeClean(c.url, { max: 6000 });
    } catch (e) {
      console.error(`portals: JD scrape failed for ${c.url} — ${e.message}`);
    }
    // A failed/empty scrape leaves the search snippet in place. That's thin, but the geo gate will
    // send it to adjudication rather than pass it — so a bad scrape can't smuggle a role through.
    if (text && text.length > c.description.length) c.description = text;
    delete c.needsJd;
    out.push(c);
  }
  // On-target roles we couldn't afford a JD for this run are dropped rather than guessed at; the
  // rotation brings their portal×query pair back around, and dedupe is by URL so nothing is lost.
  return out;
}
