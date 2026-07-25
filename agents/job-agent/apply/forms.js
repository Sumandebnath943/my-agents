// agents/job-agent/apply/forms.js — deciding what to type into which box.
//
// Application forms differ per company, so nothing here is hardcoded per job. The driver reads the
// LIVE DOM and hands each control's accessible name to `answerFor()`, which is pure and therefore
// eval-able (evals/job-apply/run.mjs). Grounded in the real markup of all three ATSes:
//   Greenhouse — server-rendered, stable ids (`first_name`, `resume`) and `aria-label` on custom
//                questions (`question_31366146003` labelled "LinkedIn Profile").
//   Lever      — server-rendered, clean `name=` attributes (`name`, `email`, `urls[LinkedIn]`).
//   Ashby      — a pure SPA: ZERO inputs in the served HTML. Playwright can still drive it once
//                hydrated, but there is nothing stable to anchor to, so it is best-effort only.
//
// THE GUIDING RULE: never guess. A required question with no confident match is reported as
// unanswered, which puts the whole application into `needs_input` and blocks submission. A wrong
// answer on a real application is far worse than an application that waits for a human.

/** Which ATS is this apply URL? null when we can't drive it. */
export function detectAts(url) {
  const u = String(url || "").toLowerCase();
  if (/(^|\.)greenhouse\.io/.test(u) || u.includes("job-boards.greenhouse.io")) return "greenhouse";
  if (u.includes("jobs.lever.co") || u.includes("hire.lever.co")) return "lever";
  if (u.includes("ashbyhq.com")) return "ashby";
  return null;
}

/** Per-ATS anchors the driver needs. Everything else is discovered from the DOM. */
export const ATS = {
  greenhouse: {
    resumeInput: "#resume, input[type=file][id*=resume]",
    coverLetterInput: "#cover_letter, input[type=file][id*=cover]",
    submit: "button[type=submit], button:has-text('Submit application')",
    confidence: "high",
  },
  lever: {
    resumeInput: "input[name=resume], #resume-upload-input",
    coverLetterInput: "input[name='cards[coverLetter]'], textarea[name*=cover]",
    submit: "button[type=submit], .postings-btn[type=submit]",
    confidence: "high",
  },
  ashby: {
    resumeInput: "input[type=file]",
    coverLetterInput: "textarea[aria-label*='cover' i]",
    submit: "button[type=submit], button:has-text('Submit')",
    // The served page has no form at all — every field is created by JavaScript, so there is no
    // stable contract to rely on. We try, and we say so when it doesn't work.
    confidence: "low",
  },
};

// --- Question matching --------------------------------------------------------------------------
// Ordered: the FIRST match wins, so more specific patterns must come first. "Expected CTC" has to
// beat the generic salary pattern, and "current company" has to beat "company".
const PATTERNS = [
  ["expected_ctc",        /\b(expected|desired|preferred)\s*(ctc|salary|compensation|package|pay)\b|\b(salary|compensation|ctc|pay)\s*(expectations?|expected|range)\b/i],
  ["current_ctc",         /\b(current|present|existing|latest)\s*(ctc|salary|compensation|package|pay|remuneration)\b|\bctc\s*\(current\)/i],
  ["notice_period",       /\bnotice\s*period\b|\b(how soon|when)\s*(can|could)\s*you\s*(join|start)\b|\bearliest\s*(joining|start)\b|\blast\s*working\s*day\b|\bavailability\s*to\s*(join|start)\b/i],
  ["years_experience",    /\b(years?|yrs?)\b[^?]{0,30}\bexperience\b|\btotal\s*experience\b|\bhow\s*many\s*years\b|\byears?\s*of\s*(relevant\s*)?experience\b/i],
  ["willing_to_relocate", /\brelocat/i],
  // Sponsorship and authorization are the SAME topic with OPPOSITE correct answers — "Do you
  // require sponsorship?" is No where "Are you authorized to work here?" is Yes. Guessing the
  // polarity would eventually put the wrong one on a real application, so they are two separate
  // keys and YOU state both in APPLY_ANSWERS. The classifier only decides which question is which.
  //
  // The polarity test is the REQUIRE-VERB, not the word "sponsorship" — that was a real bug:
  // "Do you require work authorization?" contains no "sponsorship", fell through to the
  // authorization pattern, and was answered "Yes", i.e. "yes, I need sponsorship". Backwards.
  ["needs_sponsorship",   /\b(require|requires|required|need|needs|needed|request|requesting|seek|seeking|obtain)\b[^?]{0,40}\b(sponsorship|visa|work\s*authoriz\w*|work\s*permit|immigration)\b/i],
  ["authorized_to_work",  /\b(authoriz\w*\s*to\s*work|legally\s*authoriz|eligible\s*to\s*work|permitted\s*to\s*work|right\s*to\s*work|work\s*permit|work\s*authoriz)/i],
  ["linkedin",            /\blinked\s*-?\s*in\b/i],
  ["github",              /\bgit\s*hub\b/i],
  ["twitter",             /\btwitter\b|\bx\.com\b/i],
  ["website",             /\b(website|portfolio|personal\s*(site|page)|blog|url)\b/i],
  ["current_company",     /\b(current|present)\s*(company|employer|organi[sz]ation)\b|\bwhere\s*do\s*you\s*(currently\s*)?work\b/i],
  ["current_title",       /\b(current|present)\s*(title|designation|role|position|job\s*title)\b/i],
  ["how_did_you_hear",    /\bhow\s*did\s*you\s*(hear|find|learn)\b|\breferr?al\s*source\b|\bwhere\s*did\s*you\s*(hear|find)\b/i],
  ["first_name",          /\bfirst\s*name\b|\bgiven\s*name\b/i],
  ["last_name",           /\blast\s*name\b|\bsur\s*name\b|\bfamily\s*name\b/i],
  ["full_name",           /\bfull\s*name\b|^\s*name\s*$/i],
  ["email",               /\be-?mail\b/i],
  ["phone",               /\bphone\b|\bmobile\b|\bcontact\s*number\b|\btelephone\b/i],
  ["location",            /\b(current\s*)?(location|city|based)\b|\bwhere\s*are\s*you\s*(based|located)\b/i],
  ["country",             /\bcountry\b/i],
];

// Work-authorization questions are COUNTRY-SPECIFIC and consequential. A real Postman form asks
// "Are you authorized to work in Singapore without sponsorship?" — answering that from a canned
// "authorised to work in India" is simply a wrong answer on a live application. So the canned
// answer is only ever used when the question names India or names no country at all; anything
// else is left unanswered, which blocks submission and hands the decision back to a human.
const NON_INDIA_COUNTRY_RE = /\b(u\.?s\.?a?|united states|america|canada|uk|united kingdom|britain|ireland|eu|european union|emea|germany|france|netherlands|spain|switzerland|sweden|poland|australia|new zealand|singapore|japan|china|hong kong|uae|dubai|saudi|israel|mexico|brazil|philippines|malaysia|indonesia)\b/i;

/** Is this question about work authorization / sponsorship at all? */
export const isAuthorizationQuestion = (label) =>
  /\b(authoriz|work\s*permit|sponsorship|right\s*to\s*work|visa|eligible\s*to\s*work|immigration)/i.test(String(label || ""));

/** Does this question ask about authorization in a country that isn't India? */
export function asksForeignAuthorization(label) {
  const s = String(label || "");
  if (!isAuthorizationQuestion(s)) return false;
  if (/\bindia\b/i.test(s)) return false;
  return NON_INDIA_COUNTRY_RE.test(s);
}

/**
 * Can a country-NEUTRAL authorization question ("authorized to work in the current country?") be
 * answered from the canned Yes/No? Only when the role itself is in India — then "this country"
 * unambiguously means India. For a globally-remote role at a foreign employer the same words mean
 * something else entirely, so it goes back to a human.
 * @param {string} geoClass  the job's geo_class from geo.js
 */
export const authAnswerableFor = (geoClass) => geoClass === "india_onsite" || geoClass === "india_remote";

// Questions we deliberately do NOT auto-answer. Demographic self-identification is the candidate's
// own choice to make, not something an agent should decide on their behalf.
// NOTE the deliberate absence of a trailing \b: these are STEMS. With one, "ethnic" would fail to
// match "ethnicity", "disabilit" would fail "disability" and "pronoun" would fail "pronouns" —
// which is exactly the bug the eval caught.
// Two layers, because forms present these two ways: as a QUESTION ("Race / Ethnicity") and as
// individual radio OPTIONS whose label is the answer itself ("Female", "White / Caucasian",
// "18-20"). A real Lever form produced 17 of the latter, so option text has to be recognised too.
const DEMOGRAPHIC_RE = new RegExp([
  /gender\w*|sex(ual)?|ethnic\w*|rac(e|ial)|hispanic|latino|veteran\w*|disabilit\w*|lgbt\w*/.source,
  /orientation|pronouns?|caste|religio\w*|marital|\bage\b/.source,
  // option-level labels
  /\b(female|male|non-?binary|transgender|cisgender)\b/.source,
  /\b(caucasian|african american|pacific islander|alaska native|first nations|indigenous|middle eastern|north african|two or more races|asian)\b/.source,
  /\b(prefer not to (say|answer|disclose)|decline to (self.?identify|answer|state)|i (don'?t )?wish not to answer)\b/.source,
  /\b\d{2}\s*-\s*\d{2}\b|\b\d{2}\s*or\s*(younger|older)\b/.source,   // age brackets
].join("|"), "i");

/** Is this a demographic / self-identification question? */
export const isDemographic = (label) => DEMOGRAPHIC_RE.test(String(label || ""));

/**
 * Stable key for "the same question asked again". Forms decorate labels with required-markers,
 * company names and stray whitespace ("Phone ✱", "Expected CTC*"), so a raw-string lookup would
 * miss obvious repeats. This is what makes an answer you type once get reused everywhere.
 */
export function normalizeLabel(label) {
  return String(label || "")
    .toLowerCase()
    .replace(/[✱*✱†‡]/g, " ")            // required-field markers
    .replace(/\(.*?\)/g, " ")                  // parentheticals: "(per annum)", "(optional)"
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(please|kindly|your|the|a|an|do|does|are|is|you|we|us|will|would|can|could|at|in|of|for|to|what|which|whats)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/** The canonical answer key for a question label, or null when nothing matches confidently. */
export function classifyQuestion(label) {
  const s = String(label || "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (isDemographic(s)) return null;
  if (asksForeignAuthorization(s)) return null;   // country-specific: a human answers this one
  for (const [key, re] of PATTERNS) if (re.test(s)) return key;
  return null;
}

/**
 * What should go in this field?
 * @param {{label: string, required?: boolean, kind?: string}} field
 * @param {object} answers  from loadAnswers()
 * @returns {{key: string|null, value: string|null, status: "filled"|"skipped"|"unanswered"}}
 *   skipped    — intentionally left alone (demographics); never blocks submission unless required
 *   unanswered — we have no value; blocks submission when the field is required
 */
export function answerFor(field, answers = {}, ctx = {}) {
  const label = String(field?.label || "");
  // A learned answer YOU typed on the dashboard wins over every rule below — you decided it.
  const learned = ctx.learned?.[normalizeLabel(label)];
  if (learned) return { key: "learned", value: learned, status: "filled" };

  if (isDemographic(label)) return { key: null, value: null, status: "skipped" };
  const key = classifyQuestion(label);   // also rejects foreign-country authorization questions
  if (!key) return { key: null, value: null, status: "unanswered" };
  // Country-neutral authorization questions are only safe on India-based roles.
  if ((key === "authorized_to_work" || key === "needs_sponsorship") && ctx.geo && !authAnswerableFor(ctx.geo)) {
    return { key, value: null, status: "unanswered" };
  }
  const value = answers[key];
  if (!value) return { key, value: null, status: "unanswered" };
  // A checkbox or radio can only express yes/no. Ticking one because we happen to hold a string
  // for that key ("Current role" ← job title) would be a fabricated answer, so don't claim it.
  if ((field.kind === "checkbox" || field.kind === "radio") && !/^(yes|no|true|false)$/i.test(value)) {
    return { key, value: null, status: "unanswered" };
  }
  return { key, value, status: "filled" };
}

/**
 * Plan the whole form: what gets filled, what is skipped, and what blocks submission.
 * @param {Array<{label: string, required?: boolean, kind?: string, selector?: string}>} fields
 * @returns {{fills: Array, skipped: Array, unanswered: Array, blocking: Array, canSubmit: boolean}}
 */
export function planForm(fields = [], answers = {}, ctx = {}) {
  const fills = [], skipped = [], unanswered = [];
  for (const f of fields) {
    if (!f || f.kind === "file") continue;                 // files are handled by the driver
    const r = answerFor(f, answers, ctx);
    const row = { ...f, ...r };
    if (r.status === "filled") fills.push(row);
    else if (r.status === "skipped") skipped.push(row);
    else unanswered.push(row);
  }
  // Only REQUIRED questions we couldn't answer stop the application. An optional blank is fine.
  const blocking = [...unanswered, ...skipped].filter((f) => f.required);
  return { fills, skipped, unanswered, blocking, canSubmit: blocking.length === 0 };
}

/** A short human summary for the dashboard / email. */
export function summarizePlan(plan) {
  const parts = [`${plan.fills.length} field(s) filled`];
  if (plan.skipped.length) parts.push(`${plan.skipped.length} demographic question(s) left blank`);
  if (plan.unanswered.length) parts.push(`${plan.unanswered.length} unanswered`);
  if (plan.blocking.length) parts.push(`BLOCKED on ${plan.blocking.length} required question(s)`);
  return parts.join(" · ");
}
