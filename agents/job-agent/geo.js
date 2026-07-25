// agents/job-agent/geo.js — "can a person residing in India actually hold this role?"
//
// This is the fix for the #1 source of noise: the old filter passed anything whose location string
// contained "remote", so "Remote - US", "Remote (EMEA)" and "Remote, Canada" all sailed through —
// and a BLANK location auto-passed too. Worse, the real restriction is usually stated in the
// DESCRIPTION ("must be authorized to work in the United States"), which was never read.
//
// Design: deterministic first, LLM last. Everything here is pure and offline, so it is eval-able
// (evals/job-filter/run.mjs). Only what genuinely can't be decided from text comes back as
// `unknown` — and unknown is NOT a pass; index.js batches those into one cheap LLM adjudication.
//
// PRECEDENCE (order matters, and is deliberate):
//   1. India named in the LOCATION wins outright. A Bengaluru role whose JD mentions a US office
//      must not be rejected — location is the authoritative field when it's specific.
//   2. Location that scopes remote to a foreign region, or names a foreign place → rejected.
//   3. Description that restricts work authorization / residency to a foreign country → rejected.
//   4. Genuinely global remote (worldwide / anywhere / APAC) → eligible.
//   5. India named only in the description → eligible.
//   6. Otherwise → unknown (adjudicated by one batched LLM call, never silently passed).

export const GEO = {
  INDIA_ONSITE: "india_onsite",
  INDIA_REMOTE: "india_remote",
  GLOBAL_REMOTE: "global_remote",
  FOREIGN: "foreign",
  UNKNOWN: "unknown",
};

/** Geo classes a person in India can hold. */
export const ELIGIBLE_GEOS = [GEO.INDIA_ONSITE, GEO.INDIA_REMOTE, GEO.GLOBAL_REMOTE];

// --- Vocabulary ---------------------------------------------------------------------------------

// India: the country, plus the cities that actually appear in postings. Word-boundary matching
// means "india" does NOT match "Indiana" or "Indianapolis" (the trailing letters break \b).
const INDIA_TOKENS = [
  "india", "bharat",
  "pune", "mumbai", "bombay", "navi mumbai", "thane", "bengaluru", "bangalore", "hyderabad",
  "chennai", "madras", "new delhi", "delhi", "ncr", "gurgaon", "gurugram", "noida", "faridabad",
  "kolkata", "calcutta", "ahmedabad", "gandhinagar", "surat", "vadodara", "jaipur", "indore",
  "bhopal", "nagpur", "chandigarh", "mohali", "kochi", "cochin", "ernakulam", "trivandrum",
  "thiruvananthapuram", "coimbatore", "mysore", "mysuru", "madurai", "visakhapatnam", "vizag",
  "bhubaneswar", "lucknow", "kanpur", "dehradun", "guwahati", "patna", "raipur", "goa", "panaji",
];

// Regions/countries that EXCLUDE India when a role is scoped to them.
// APAC / Asia-Pacific deliberately absent — those normally include India (see GLOBAL_TOKENS).
const FOREIGN_TOKENS = [
  "u\\.s\\.a?", "us", "usa", "united states", "america", "americas", "north america", "stateside",
  "latam", "latin america", "canada", "canadian", "mexico", "brazil", "argentina",
  "uk", "u\\.k\\.", "united kingdom", "england", "scotland", "wales", "ireland", "britain",
  "eu", "europe", "european union", "emea", "germany", "france", "netherlands", "spain", "portugal",
  "poland", "sweden", "norway", "denmark", "finland", "switzerland", "austria", "belgium", "italy",
  "czechia", "romania", "australia", "new zealand", "anz",
  "singapore", "japan", "south korea", "china", "hong kong", "taiwan", "vietnam", "thailand",
  "malaysia", "indonesia", "philippines", "southeast asia", "south east asia",
  "uae", "dubai", "abu dhabi", "saudi arabia", "qatar", "israel", "south africa", "nigeria", "kenya",
];

// US states and Canadian provinces spelled out — postings often give a bare "Indiana" or
// "Ontario" with no country. Note "Indiana" must be listed here for it to be caught at all:
// INDIA_RE deliberately will not match it (the trailing "na" breaks the word boundary).
const FOREIGN_SUBDIVISIONS = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware",
  "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky",
  "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota", "mississippi",
  "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey", "new mexico",
  "new york state", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania",
  "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont",
  "virginia", "washington", "west virginia", "wisconsin", "wyoming",
  "ontario", "quebec", "alberta", "british columbia", "manitoba", "saskatchewan", "nova scotia",
];

// Foreign cities that show up as bare location strings ("San Francisco, CA", "London").
const FOREIGN_CITIES = [
  "san francisco", "sf bay area", "bay area", "new york", "nyc", "brooklyn", "boston", "seattle",
  "austin", "chicago", "denver", "atlanta", "los angeles", "san diego", "san jose", "palo alto",
  "mountain view", "sunnyvale", "cupertino", "redmond", "washington dc", "miami", "dallas", "houston",
  "phoenix", "portland", "philadelphia", "detroit", "minneapolis", "salt lake city", "raleigh",
  "toronto", "vancouver", "montreal", "ottawa",
  "london", "manchester", "edinburgh", "dublin", "berlin", "munich", "hamburg", "amsterdam",
  "rotterdam", "paris", "madrid", "barcelona", "lisbon", "milan", "rome", "zurich", "geneva",
  "stockholm", "copenhagen", "oslo", "helsinki", "warsaw", "prague", "vienna", "brussels",
  "sydney", "melbourne", "brisbane", "auckland", "tokyo", "osaka", "seoul", "shanghai", "beijing",
  "shenzhen", "tel aviv", "cape town", "johannesburg", "sao paulo", "mexico city", "buenos aires",
];

// Truly location-independent phrasing. Two strengths, because context differs:
//   LOC  — a location field reading "Anywhere" or "Global" genuinely means global.
//   TEXT — in a DESCRIPTION, "global" and "anywhere" are marketing boilerplate ("a global leader
//          in…"), so only unambiguous multi-word phrasing counts, and "anywhere in the US" is
//          explicitly excluded by lookahead.
const GLOBAL_LOC_TOKENS = [
  "worldwide", "world wide", "anywhere", "global", "globally", "any location", "no location",
  "apac", "asia pacific", "asia-pacific",
];
const GLOBAL_TEXT_TOKENS = [
  "worldwide", "world wide", "anywhere in the world", "globally remote", "global remote",
  "remote global", "fully distributed", "location independent", "location-independent",
  "apac", "asia pacific", "asia-pacific",
];

const alt = (list) => list.join("|");
const bounded = (list) => new RegExp(`(?<![a-z])(?:${alt(list)})(?![a-z])`, "i");

const INDIA_RE = bounded(INDIA_TOKENS);
// For LOCATION strings: the full foreign vocabulary, including bare "US".
const FOREIGN_PLACE_RE = bounded([...FOREIGN_TOKENS, ...FOREIGN_CITIES, ...FOREIGN_SUBDIVISIONS]);
// For DESCRIPTIONS: bare "us" is the English pronoun ("join us", "contact us"), so it is dropped —
// the country still matches via "u.s.", "usa" and "united states".
const FOREIGN_TEXT_RE = bounded([...FOREIGN_TOKENS.filter((t) => t !== "us"), ...FOREIGN_CITIES, ...FOREIGN_SUBDIVISIONS]);
const GLOBAL_LOC_RE = bounded(GLOBAL_LOC_TOKENS);
const REMOTE_RE = /(?<![a-z])(?:remote|work\s+from\s+home|wfh|distributed)(?![a-z])/i;

// "San Francisco, CA" / "Austin, TX" — a US state code after a comma is a strong foreign signal.
const US_STATE_RE = /,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/;

// Remote scoped to a foreign region: "Remote - US", "Remote (EMEA)", "Remote, Canada",
// "Remote in the United Kingdom", and the reverse form "US Remote", "EMEA-Remote".
const REMOTE_SCOPED_RE = new RegExp(
  `(?<![a-z])remote(?![a-z])\\s*[-–—,:(/|]*\\s*(?:in|within|from|based\\s+in|across)?\\s*(?:the\\s+)?(?:${alt(FOREIGN_TOKENS)})(?![a-z])`,
  "i",
);
const SCOPED_REMOTE_RE = new RegExp(
  `(?<![a-z])(?:${alt(FOREIGN_TOKENS)})(?![a-z])\\s*[-–—,]?\\s*(?:only\\s+)?remote(?![a-z])`,
  "i",
);
// Greenhouse/Lever postings carry LinkedIn routing tags like "#LI-Remote-US".
const LI_TAG_RE = /#li-remote-(?:us|usa|na|emea|eu|uk|ca|latam|apj)/i;

// Description-level restrictions. These are what actually disqualify most "remote" roles.
const F = alt(FOREIGN_TOKENS);
const RESTRICTION_RES = [
  new RegExp(`\\b(?:must|should|need|required?)\\b[^.]{0,40}\\b(?:legally\\s+)?(?:authoriz|eligib|entitl)\\w*\\s+to\\s+work\\s+in\\s+(?:the\\s+)?(?:${F})(?![a-z])`, "i"),
  new RegExp(`\\bwork\\s+authoriz\\w*\\s+(?:in|for)\\s+(?:the\\s+)?(?:${F})(?![a-z])`, "i"),
  new RegExp(`\\b(?:right|permission|authorization)\\s+to\\s+work\\s+in\\s+(?:the\\s+)?(?:${F})(?![a-z])`, "i"),
  new RegExp(`\\bvalid\\s+(?:${F})\\s+(?:work\\s+)?(?:visa|permit|authorization)`, "i"),
  new RegExp(`\\bmust\\s+(?:reside|live|be\\s+located|be\\s+based|be\\s+physically\\s+located)\\s+(?:in|within)\\s+(?:the\\s+)?(?:${F})(?![a-z])`, "i"),
  new RegExp(`\\bopen\\s+(?:only\\s+)?to\\s+(?:candidates|applicants)?\\s*(?:who\\s+are\\s+)?(?:in|residing\\s+in|located\\s+in|based\\s+in)\\s+(?:the\\s+)?(?:${F})(?![a-z])`, "i"),
  new RegExp(`(?:${F})(?![a-z])[-\\s]*(?:based\\s+)?(?:candidates|applicants|residents|citizens)\\s+only`, "i"),
  new RegExp(`\\b(?:this\\s+)?(?:role|position|job)\\s+is\\s+(?:only\\s+)?(?:available|open)\\s+(?:to|for|in)\\s+(?:candidates\\s+)?(?:in\\s+)?(?:the\\s+)?(?:${F})(?![a-z])`, "i"),
  new RegExp(`\\b(?:this\\s+)?(?:role|position)\\s+is\\s+(?:based|located)\\s+in\\s+(?:our\\s+)?(?:${alt(FOREIGN_CITIES)})(?![a-z])`, "i"),
  // "Work from anywhere in the US" / "remote within the EU" — freedom-sounding phrasing that is
  // in fact a country restriction. Must be a rejection, not merely "not global".
  new RegExp(`\\b(?:anywhere|remotely|remote)\\s+(?:in|within|across)\\s+(?:the\\s+)?(?:${F})(?![a-z])`, "i"),
];

// "We are unable to sponsor visas" implies you already hold local authorization. On its own that's
// ambiguous, so it only rejects when the posting also names a foreign region — otherwise it's a flag.
const NO_SPONSOR_RE = /\b(?:unable\s+to|cannot|can'?t|do(?:es)?\s+not|will\s+not|won'?t)\s+(?:be\s+able\s+to\s+)?(?:provide|offer|sponsor)\w*\s+(?:employment\s+|work\s+)?(?:visa|visas|sponsorship|immigration)/i;

// "Work from anywhere" is only global if it isn't immediately narrowed ("anywhere in the US").
const GLOBAL_TEXT_RE = new RegExp(
  `(?<![a-z])(?:work\\s+from\\s+anywhere|(?:${alt(GLOBAL_TEXT_TOKENS)}))(?![a-z])(?!\\s+(?:in|within|across)\\s+(?:the\\s+)?(?:${F}))`,
  "i",
);

// Not a rejection — a heads-up that the role wants US/EU working hours.
const TZ_RE = /\b(?:overlap|align|work)\w*\s+(?:with\s+)?(?:\d+\+?\s*(?:hours|hrs)\s+)?(?:with\s+)?(?:pst|pdt|est|edt|cst|cdt|mst|gmt|bst|cet|pacific|eastern|central)\s*(?:time|timezone|time\s+zone|hours)?/i;

// --- Classifier ---------------------------------------------------------------------------------

/**
 * Decide whether a role is holdable from India. Pure, offline, no network.
 * @param {{location?: string, description?: string, title?: string}} job
 * @returns {{geo: string, eligible: boolean|null, reason: string, flags: string[]}}
 *   eligible: true = yes · false = rejected · null = undecidable from text (needs adjudication)
 */
export function classifyGeo(job = {}) {
  const loc = String(job.location || "").trim();
  const desc = String(job.description || "");
  const hay = `${loc}\n${desc}`;
  const flags = [];
  if (TZ_RE.test(desc)) flags.push("wants US/EU working hours");

  // 1. India named in the location — authoritative, decided.
  if (INDIA_RE.test(loc)) {
    const remote = REMOTE_RE.test(loc);
    return {
      geo: remote ? GEO.INDIA_REMOTE : GEO.INDIA_ONSITE,
      eligible: true,
      reason: `location names India (“${loc}”)`,
      flags,
    };
  }

  // 2. Location scopes the role to somewhere else.
  if (LI_TAG_RE.test(hay)) return rejected(GEO.FOREIGN, "posting is tagged remote for a non-India region", flags);
  if (REMOTE_SCOPED_RE.test(loc) || SCOPED_REMOTE_RE.test(loc)) {
    return rejected(GEO.FOREIGN, `remote is scoped to a non-India region (“${loc}”)`, flags);
  }
  if (loc && !GLOBAL_LOC_RE.test(loc) && (US_STATE_RE.test(loc) || FOREIGN_PLACE_RE.test(loc))) {
    return rejected(GEO.FOREIGN, `location is outside India (“${loc}”)`, flags);
  }

  // 3. Description restricts work authorization or residency to another country.
  for (const re of RESTRICTION_RES) {
    const m = desc.match(re);
    if (m) return rejected(GEO.FOREIGN, `description restricts eligibility: “${snippet(m[0])}”`, flags);
  }
  if (NO_SPONSOR_RE.test(desc) && FOREIGN_TEXT_RE.test(desc) && !INDIA_RE.test(desc)) {
    return rejected(GEO.FOREIGN, "description rules out visa sponsorship for a non-India location", flags);
  }
  if (NO_SPONSOR_RE.test(desc)) flags.push("no visa sponsorship offered");

  // 4. Genuinely global remote. A location field of "Anywhere"/"Worldwide"/"APAC" is itself
  // sufficient; inside a description we demand unambiguous phrasing (see GLOBAL_TEXT_RE).
  if (loc && GLOBAL_LOC_RE.test(loc)) {
    return { geo: GEO.GLOBAL_REMOTE, eligible: true, reason: `location is open worldwide (“${loc}”)`, flags };
  }
  if (REMOTE_RE.test(hay) && GLOBAL_TEXT_RE.test(desc)) {
    return { geo: GEO.GLOBAL_REMOTE, eligible: true, reason: "remote and open worldwide / APAC", flags };
  }

  // 5. India appears only in the description (blank or generic location).
  if (INDIA_RE.test(desc)) {
    return {
      geo: REMOTE_RE.test(hay) ? GEO.INDIA_REMOTE : GEO.INDIA_ONSITE,
      eligible: true,
      reason: "description names an India location",
      flags,
    };
  }

  // 6. Undecidable. NOT a pass — index.js adjudicates these with one batched LLM call.
  return {
    geo: GEO.UNKNOWN,
    eligible: null,
    reason: loc ? `location “${loc}” names no country` : "no location given and description names none",
    flags,
  };
}

const rejected = (geo, reason, flags) => ({ geo, eligible: false, reason, flags });
const snippet = (s) => String(s).replace(/\s+/g, " ").trim().slice(0, 90);

/** Convenience: did this job clear the geo gate? Unknown counts as NOT cleared. */
export const isIndiaEligible = (verdict) => verdict?.eligible === true;

// --- City canonicalisation ----------------------------------------------------------------------
// The same office is written a dozen ways across sources — "Bangalore", "Bengaluru, Karnataka",
// "BLR", "Bengaluru, Karnataka, India". Duplicate detection needs them to collapse to one token.
const CITY_ALIASES = {
  bangalore: "bengaluru", blr: "bengaluru", bengaluru: "bengaluru",
  bombay: "mumbai", mumbai: "mumbai", "navi mumbai": "mumbai", thane: "mumbai",
  "new delhi": "delhi", delhi: "delhi", ncr: "delhi", gurgaon: "gurugram", gurugram: "gurugram",
  noida: "noida", faridabad: "delhi",
  calcutta: "kolkata", kolkata: "kolkata",
  madras: "chennai", chennai: "chennai",
  mysore: "mysuru", mysuru: "mysuru",
  cochin: "kochi", kochi: "kochi", ernakulam: "kochi",
  trivandrum: "thiruvananthapuram", thiruvananthapuram: "thiruvananthapuram",
  vizag: "visakhapatnam", visakhapatnam: "visakhapatnam",
  poona: "pune", pune: "pune", hyderabad: "hyderabad", ahmedabad: "ahmedabad",
  gandhinagar: "ahmedabad", jaipur: "jaipur", indore: "indore", chandigarh: "chandigarh",
  mohali: "chandigarh", coimbatore: "coimbatore", nagpur: "nagpur", bhubaneswar: "bhubaneswar",
  lucknow: "lucknow", surat: "surat", vadodara: "vadodara", goa: "goa", panaji: "goa",
};

/**
 * One canonical city token for a location string, or "" when none is recognised.
 * Longest alias first so "navi mumbai" wins over "mumbai".
 */
export function cityOf(text) {
  const s = String(text || "").toLowerCase();
  if (!s) return "";
  const keys = Object.keys(CITY_ALIASES).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (new RegExp(`(?<![a-z])${k.replace(/\s+/g, "\\s+")}(?![a-z])`, "i").test(s)) return CITY_ALIASES[k];
  }
  return "";
}
