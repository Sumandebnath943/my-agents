// agents/job-agent/dedupe.js — one job, one entry.
//
// THE BUG THIS FIXES: deduplication used to be by URL alone. That held while every role came from
// a company's own ATS board, where each job appears exactly once. Adding nine job portals broke the
// assumption — the same Nokia role now arrives from Naukri, from LinkedIn AND from the company's
// own careers page, at three different URLs. Three rows, three LLM scoring calls, three cover
// letters, three lines in the email, for one job.
//
// So matching has to be on CONTENT, not address: company + title + city, each normalised so the
// same thing written three ways collapses to one fingerprint.
//
// Pure and offline — evals/job-dedupe covers it.
import { cityOf } from "./geo.js";

// Which source do we keep when the same role arrives from several? Ranked by what it lets you DO:
// a company's own ATS form can be filled in by the agent (see apply/run.js), a portal listing can
// only ever be applied to by hand. Lower number wins.
export const SOURCE_RANK = {
  greenhouse: 0, lever: 0, ashby: 1,          // drivable application forms
  workatastartup: 2, wellfound: 2,            // startup boards, usually the employer's own post
  linkedin: 3, instahyre: 3, iimjobs: 3, hirist: 3, cutshort: 3, uplers: 3, naukri: 3,
  remoteok: 4, arbeitnow: 4,                  // aggregators, most likely to be a reposting
};
export const rankOf = (source) => SOURCE_RANK[String(source || "").toLowerCase()] ?? 5;

const LEGAL = /\b(inc|llc|ltd|limited|corp|corporation|company|co|pvt|private|plc|gmbh|bv|sa|ag|technologies|technology|labs|solutions|services|india|global|group|holdings|the)\b/g;

/** "Nokia Corporation" / "NOKIA India Pvt Ltd" -> "nokia" */
export function normalizeCompany(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[&+]/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(LEGAL, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * "Sr. Product Marketing Manager (Remote) - Bangalore | Naukri #12345" -> "senior product marketing manager"
 * Seniority is DELIBERATELY kept — "Senior PMM" and "PMM" are different jobs, not one job written
 * two ways — but abbreviations are expanded so "Sr." and "Senior" match.
 */
// Parentheticals are only noise SOMETIMES. "(Remote)" and "(6 month contract)" say nothing about
// which job it is; "(Danish Speaking)", "(EMEA)" and "(Enterprise)" absolutely do. Stripping all of
// them merged Postman's Danish- and Swedish-speaking roles into one on live data, so only the
// known-noise ones go.
const NOISE_PAREN = /^(remote|hybrid|on[\s-]?site|in[\s-]?office|contract(or)?|freelance|full[\s-]?time|part[\s-]?time|permanent|temp(orary)?|fixed[\s-]?term|\d+\s*(month|year)s?[\s\w]*|maternity\s*cover|paternity\s*cover|[mfwdx]\/[mfwdx](\/[mfwdx])?|all\s+genders|any\s+gender|urgent|hiring|new|open)$/i;

export function normalizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    // Keep meaningful parentheticals as plain words; drop only the noise ones.
    .replace(/\(([^)]*)\)/g, (_, inner) => (NOISE_PAREN.test(String(inner).trim()) ? " " : ` ${inner} `))
    .replace(/[|#].*$/, " ")                          // portal branding, requisition ids
    .replace(/\b(req|requisition|job|posting)\s*(id|no|number)?\s*[:#-]?\s*\w*\d\w*/gi, " ")
    .replace(/\bsr\.?\b/g, "senior")
    .replace(/\bjr\.?\b/g, "junior")
    .replace(/\bmgr\.?\b/g, "manager")
    .replace(/\bassoc\.?\b/g, "associate")
    .replace(/\bvp\b/g, "vice president")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A comparable key for a location.
 *
 * CRITICAL DISTINCTION, learned the hard way on live data: "no location given" and "a location we
 * don't have an alias for" are NOT the same thing. cityOf() only knows Indian cities, so it
 * returns "" for both "" and "Dallas, Texas" — and treating that "" as a wildcard merged
 * Postman's "Key Account Director" in Dallas, Seattle, Toronto, Chicago and Los Angeles into a
 * single role. An empty key must mean genuinely unspecified, nothing else.
 */
export function locationKey(location) {
  const raw = String(location || "").trim();
  if (!raw) return "";                                  // genuinely unspecified — the only wildcard
  const india = cityOf(raw);
  if (india) return india;                              // canonical, so Bangalore == Bengaluru
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The identity of a role, independent of where it was found.
 * Returns "" when there isn't enough to match on — an unknown company must NEVER be fingerprinted,
 * or two different employers advertising "Product Manager" would collapse into one.
 */
export function fingerprint(job = {}) {
  const company = normalizeCompany(job.company);
  const title = normalizeTitle(job.title);
  if (!company || company === "unknown" || !title) return "";
  return `${company}|${title}|${locationKey(job.location)}`;
}

/** Do two fingerprints describe the same role? An unknown city matches a known one. */
export function sameRole(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [ca, ta, cta] = a.split("|");
  const [cb, tb, ctb] = b.split("|");
  if (ca !== cb || ta !== tb) return false;
  // Same company and title: a posting that named no city is the same role as one that did.
  // Two DIFFERENT known cities stay separate — those are genuinely two openings.
  return !cta || !ctb;
}

// India first, always. If a merge ever does span geographies, keeping the foreign copy would make
// an India-eligible role disappear from the search entirely — the worst outcome this whole agent
// exists to prevent.
const GEO_RANK = { india_onsite: 0, india_remote: 0, global_remote: 1, unknown: 2, foreign: 3 };
const geoRankOf = (j) => GEO_RANK[j?.screen?.geo?.geo ?? j?.geo_class] ?? 2;

/** Of several copies of one role, which do we keep? India, then best source, then richest record. */
export function pickBest(group = []) {
  return [...group].sort((a, b) => {
    const g = geoRankOf(a) - geoRankOf(b);
    if (g) return g;
    const r = rankOf(a.source || a.ats) - rankOf(b.source || b.ats);
    if (r) return r;
    const desc = String(b.description || "").length - String(a.description || "").length;
    if (desc) return desc;
    const sal = (b.salary ? 1 : 0) - (a.salary ? 1 : 0);
    if (sal) return sal;
    return (b.posted_at ? 1 : 0) - (a.posted_at ? 1 : 0);
  })[0];
}

/**
 * Collapse duplicates within one batch.
 * Roles with no usable fingerprint pass through untouched — better a duplicate than a wrong merge.
 * @returns {{unique: Array, dropped: Array<{kept: object, dropped: object}>}}
 */
export function dedupe(jobs = []) {
  const groups = [];          // [{ fp, items: [] }]
  const unmatchable = [];
  for (const j of jobs) {
    if (!j) continue;
    const fp = fingerprint(j);
    if (!fp) { unmatchable.push(j); continue; }
    const g = groups.find((x) => sameRole(x.fp, fp));
    if (g) {
      g.items.push({ ...j, _fp: fp });
      // Prefer the more specific fingerprint so the group keeps its city once one copy names it.
      if (fp.split("|")[2] && !g.fp.split("|")[2]) g.fp = fp;
    } else {
      groups.push({ fp, items: [{ ...j, _fp: fp }] });
    }
  }

  const unique = [...unmatchable];
  const dropped = [];
  for (const g of groups) {
    const best = pickBest(g.items);
    unique.push({ ...best, fingerprint: g.fp });
    for (const other of g.items) if (other !== best) dropped.push({ kept: best, dropped: other });
  }
  return { unique, dropped };
}

/** Human line for the run log / email. */
export const summarizeDedupe = (dropped) => {
  if (!dropped.length) return "";
  const bySource = {};
  for (const d of dropped) {
    const s = d.dropped.source || d.dropped.ats || "?";
    bySource[s] = (bySource[s] || 0) + 1;
  }
  return `${dropped.length} duplicate(s) collapsed (${Object.entries(bySource).map(([s, n]) => `${n} from ${s}`).join(", ")})`;
};
