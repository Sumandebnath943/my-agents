// agents/job-agent/config.js — your targeting. This file IS your job-search strategy.
//
// GEOGRAPHY IS A HARD GATE, not a preference: you live in India, so a role qualifies only if a
// person residing in India can actually hold it. "Remote" alone never qualifies a role — most
// remote postings are country-restricted, and that restriction usually lives in the DESCRIPTION,
// not the location field. See geo.js for the classifier that enforces this.

// --- Titles ------------------------------------------------------------------------------------
// DOMAIN × LEVEL, not a list of phrases.
//
// The old version matched fixed word-order phrases like /marketing\s+(manager|lead)/, which meant
// "Marketing Manager" matched but "Senior Manager - Marketing" did NOT — and that hyphenated,
// reversed format is everywhere in Indian corporate postings. Same for "AVP Marketing",
// "General Manager Marketing", "Lead Marketing" and "Head of Brand". Measuring 35 realistic
// variants, 12 were being silently discarded.
//
// A title now qualifies when it names a DOMAIN we care about AND a LEVEL, in any order, and hits
// none of the exclusions. Seniority is judged by the LLM fit score, not thrown away by a regex —
// there is no years-of-experience floor and plain "Manager" is in scope.

/** Seniority / role-shape words. A title with no level word is not a role we target. */
export const LEVELS = [
  /\bmanagers?\b/i, /\bmanagement\b/i, /\blead(er)?\b/i, /\bheads?\b/i, /\bdirectors?\b/i,
  /\bavp\b/i, /\bvps?\b/i, /\bvice\s*president\b/i, /\bsvp\b/i, /\bevp\b/i,
  /\bgm\b/i, /\bdgm\b/i, /\bagm\b/i, /\bgeneral\s*manager\b/i,
  /\bprincipal\b/i, /\bchief\b/i, /\bcmo\b/i, /\bcpo\b/i, /\bowner\b/i, /\bspecialist\b/i,
  // Abbreviations that already ENCODE the level, so they satisfy this test on their own —
  // "PMM, Enterprise" is a real Greenhouse title and names no separate level word.
  /\bpmm\b/i, /\bgpm\b/i, /\bapm\b/i,
  /\bstrategist\b/i, /\bevangelist\b/i, /\barchitect\b/i, /\bpartner\b/i,
];

// Checked IN ORDER — the first domain that matches decides the family, so the specific ones
// ("product marketing", "marketing operations") must come before the general ones ("marketing").
export const DOMAINS = [
  { family: "pmm", label: "Product Marketing",
    re: /\bproduct\s*marketing\b|\bpmm\b|\bgtm\b|\bgo[\s-]?to[\s-]?market\b|\bproduct\s*evangelis/i },
  { family: "ai", label: "AI / GenAI product & marketing",
    re: /\b(ai|a\.i\.|genai|gen\s*ai|generative\s*ai|llm|machine\s*learning)\b[\w\s,/&-]*\b(product|marketing|gtm|growth|evangelist|advocate)\b|\b(product|marketing|gtm|growth)\b[\w\s,/&-]*\b(ai|genai|gen\s*ai|generative\s*ai|llm)\b/i },
  { family: "pm", label: "Product Management",
    re: /\bproducts?\b/i },
  { family: "ops", label: "Marketing ops / demand gen / lifecycle",
    re: /\bmarketing\s*(operations|ops|automation|technology)\b|\bmartech\b|\bdemand\s*gen\w*\b|\blifecycle\s*marketing\b|\bcrm\s*marketing\b|\bmarketing\s*analytics\b/i },
  { family: "comms", label: "Communications / PR",
    re: /\bcommunications?\b|\bcorporate\s*comms?\b|\bpublic\s*relations\b|\bpr\b|\bmedia\s*relations\b/i },
  { family: "growth_brand", label: "Growth / Brand / Digital / Marketing leadership",
    // "digital" must be qualified: bare \bdigital\b matched "Internal Audit Lead, Stablecoins &
    // Digital Assets" on a live board.
    re: /\bmarketing\b|\bbrand(ing)?\b|\bgrowth\b|\bdigital\s*(marketing|media|growth|commerce|channels?|strategy|acquisition)\b|\bperformance\s*marketing\b|\bcontent\b|\bsocial\s*media\b|\bcampaigns?\b|\bseo\b|\bsem\b|\becommerce\b|\be-commerce\b|\binfluencer\b|\bcommunity\b/i },
];

// Titles that are never in scope, whatever else they match. Two groups:
//   1. Seniority floor — genuinely entry-level ("Marketing Executive" is a fresher role in India).
//   2. Wrong function — titles that contain "manager"/"marketing" but are a different job.
// NOTE: `product manager` must never be caught by `project manager` — keep these anchored.
export const TITLE_EXCLUDE = [
  // 1. entry-level
  /\bintern(ship)?\b/i, /\btrainee\b/i, /\bfresher\b/i, /\bapprentice\b/i, /\bgraduate\s+(program|scheme|trainee)\b/i,
  /\bentry[\s-]level\b/i, /\bjunior\b/i, /\bmarketing\s+executive\b/i, /\bcoordinator\b/i, /\bwalk[\s-]?in\b/i,
  // 2. wrong function. Most of these are already impossible now that a title must also name a
  // marketing/product DOMAIN — "Operations Manager" has no domain and dies anyway. These stay for
  // the compound cases a domain word would otherwise rescue, e.g. "Product Sales Manager".
  // NOTE: `operations` and `community` are deliberately NOT here — they would have killed
  // "Marketing Operations Manager" and "Community Marketing Manager", both of which are in scope.
  /\b(account|sales|project|program|category|hr|people|partner|alliance|channel|customer\s+success|key\s+account|business\s+development|relationship|branch|store|area\s+sales|territory|facility|warehouse|logistics|procurement|vendor)\s+manager\b/i,
  /\b(sdr|bdr|telecaller|telesales|field\s+sales|inside\s+sales|counsell?or|faculty|professor|lecturer|teacher|recruiter|talent\s+acquisition)\b/i,
  // 3. neighbours that ride in on the word "Product" or "Growth". Every one of these was observed
  // leaking on a live board audit: "Product Design Manager", "Engineering Manager, Growth",
  // "Product Support Manager", "Senior People Business Partner, Product & Marketing",
  // "Internal Audit Lead", "Director, Product Partnerships", "Tech & Product Strategic Sourcing".
  /\b(design|ux|ui|user\s+experience|user\s+interface|graphic|visual|illustrat\w*|animat\w*)\b/i,
  /\b(engineering|software|devops|sre|infrastructure|backend|frontend|full\s*stack|qa|test(ing)?\s+manager)\b/i,
  /\bsupport\b/i,
  /\baudit\w*\b/i,
  /\bbusiness\s+partner\b/i,
  /\bpartnerships?\b/i,
  /\b(strategic\s+)?sourcing\b/i,
  /\b(user|product|ux)\s+research\w*\b/i,
];

// --- AI-product requirement ---------------------------------------------------------------------
// Owner's rule: a PRODUCT role (product management or product marketing) is only interesting if the
// product itself is AI. A "Product Lead" for a conventional payments product is not — but this must
// NOT be read as "no product roles", which is the opposite of the truth. The other families
// (brand, marketing, digital, performance, comms, ops) are wanted from ANY industry.
export const AI_REQUIRED_FAMILIES = ["pmm", "pm"];

// Flag rather than reject, for now. A vaguely-written AI role would otherwise vanish silently, and
// the detector has never been run in anger. Flip to "reject" once the flag proves accurate.
export const AI_GATE_MODE = "flag";        // "flag" | "reject"

// Signals that the PRODUCT is AI — not merely that the company mentions AI in its boilerplate.
export const AI_SIGNALS = [
  /\b(ai|a\.i\.|genai|gen\s*ai|generative\s*ai)\b/i,
  /\b(llm|large language model|foundation model|transformer|diffusion)\b/i,
  /\b(machine learning|deep learning|neural|nlp|natural language|computer vision)\b/i,
  /\b(agentic|ai agent|copilot|chatbot|conversational ai|rag|retrieval augmented)\b/i,
  /\b(ml\s*(ops|platform|engineer|model)|inference|fine[- ]tun\w+|prompt engineering|embeddings?)\b/i,
];

// --- Compensation ------------------------------------------------------------------------------
// CRITICAL: this gate rejects ONLY when a posting DISCLOSES a range that sits entirely below the
// floor. Most postings disclose nothing — those pass and are flagged "comp unknown". Rejecting on
// missing salary would delete most of the good roles.
export const MIN_CTC_LPA = 11;        // lakhs per annum, INR
export const EXPECTED_CTC_LPA = 14;   // what we tell application forms (separate from the floor)

// --- Freshness ---------------------------------------------------------------------------------
// Applies only when a source gives us a posting date. Undated roles are not rejected for age.
//
// Measured on a live pull of the ATS boards (108 on-target roles): 0–7d = 8, 8–30d = 23,
// 31–60d = 21, 61–90d = 18, 91–180d = 26, 180+d = 4. A 30-day cut throws away two thirds of them,
// and on company ATS boards age is a weak death signal — Greenhouse/Lever/Ashby drop filled reqs,
// so a listing that is still up is still open. 60 days keeps roughly half and drops the truly
// stale. Job PORTALS behave differently (dead posts linger), so Phase 1 makes this per-source.
export const MAX_AGE_DAYS = 60;

// --- Companies to never surface ----------------------------------------------------------------
// Matched case-insensitively as substrings against the company name.
export const COMPANY_EXCLUDE = [
  "pune institute of business management",
  "pibm",
];

// --- Portal sourcing ---------------------------------------------------------------------------
// The search phrases used to discover postings on the job portals (see portals.js). Keep these
// close to how a posting is actually TITLED — they are matched against search-result titles, then
// re-checked against DOMAINS × LEVELS, so a loose phrase here costs nothing but a wasted search.
// NOTE: no "senior"/"lead"/"head of" variants of the same role. A search for "brand manager"
// already returns the senior postings, and matchTitle re-checks seniority afterwards anyway — so
// a seniority variant would burn a search slot for results we already have. These are 20 DISTINCT
// role types instead.
export const PORTAL_QUERIES = [
  "product marketing manager",
  "AI product marketing manager",
  "product manager",
  "AI product manager",
  "brand manager",
  "brand marketing manager",
  "marketing manager",
  "digital marketing manager",
  "performance marketing manager",
  "growth marketing manager",
  "social media manager",
  "content marketing manager",
  "campaign manager",
  "marketing communications manager",
  "public relations manager",
  "marketing operations manager",
  "demand generation manager",
  "lifecycle marketing manager",
  "head of marketing",
  "marketing director",
];

// PER-RUN BUDGET. Firecrawl (500/mo) and Tavily (1000/mo) are shared with the rest of the fleet —
// read-later, notes and the MCP tools also draw on them.
//
// The trade-off to understand: 20 queries × 9 portals = 180 pairs. At 20 searches per run and ~22
// weekday runs a month, every pair is searched about every 9 runs — roughly a FORTNIGHT. That is
// deliberately shorter than MAX_AGE_DAYS (60), so a job posted the day after its pair was last
// searched is still well inside the freshness window when the rotation comes back to it. Raising
// the query count without raising searches-per-run would stretch the cycle past that point and
// start missing roles.
//
// Cost at these settings: ~440 Tavily and ~308 Firecrawl calls a month, both inside the free tiers
// with headroom for the other agents.
export const PORTAL_SEARCHES_PER_RUN = 20;     // Tavily calls (discovery)
export const PORTAL_JD_SCRAPES_PER_RUN = 14;   // Firecrawl calls (full job descriptions)

// --- Scoring -----------------------------------------------------------------------------------
export const MIN_FIT = 65;      // only surface roles scoring >= this
export const SCORE_CAP = 25;    // max roles sent to the LLM per run (survivors only, post-filter)
export const EMAIL_CAP = 8;     // max roles in the email; the rest live on the dashboard

// --- Company ATS boards we watch ---------------------------------------------------------------
// Auto-resolved from company names by resolve-slugs.js (edit companies.txt and re-run to add more;
// it probes the public APIs so you never hand-guess a slug). Greenhouse = boards.greenhouse.io/<slug>;
// Lever = jobs.lever.co/<slug>; Ashby = jobs.ashbyhq.com/<slug>.
//
// A REALITY CHECK worth remembering before adding more: 97 Indian companies were probed against
// all three ATSes and only THREE had a verified board (InMobi, Observe.AI, Paytm). Razorpay,
// Swiggy, Zomato, Flipkart, Zoho, Zepto, Meesho-scale companies overwhelmingly run their own
// careers portals, Darwinbox/Keka/Workday, or simply Naukri — none of which expose a public JSON
// board. That is precisely why portals.js exists; this list cannot reach the Indian market alone.
export const GREENHOUSE = ["airtable", "algolia", "amplitude", "anthropic", "asana", "brex", "calendly", "cloudflare", "coinbase", "contentful", "cresta", "cultureamp", "databricks", "datadog", "descript", "discord", "dropbox", "elastic", "figma", "gitlab", "grafanalabs", "groww", "inmobi", "instacart", "intercom", "lattice", "mercury", "mixpanel", "mongodb", "netlify", "observeai", "okta", "pendo", "phonepe", "pinterest", "postman", "reddit", "remote", "scaleai", "stripe", "togetherai", "twilio", "vercel", "webflow"];
export const LEVER = ["clari", "cred", "freshworks", "meesho", "mindtickle", "outreach", "paytm", "zeta"];
export const ASHBY = ["1password", "atlan", "clickup", "cohere", "confluent", "deel", "elevenlabs", "harvey", "linear", "loom", "miro", "notion", "openai", "perplexity", "pinecone", "plaid", "ramp", "runway", "sanity", "sentry", "sierra", "snowflake", "synthesia", "writer", "zapier"];
