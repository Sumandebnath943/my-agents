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
  // The survey found FIFTEEN distinct wordings across 186 forms. The window is widened to 80 chars
  // because real phrasings are long: "Will you now or will you in the future require employment
  // visa sponsorship to work in the country in which the job you're applying for is located?"
  ["needs_sponsorship",   /\b(require|requires|required|need|needs|needed|request|requesting|seek|seeking|commence|obtain)\b[^?]{0,80}\b(sponsorship|sponsor|visa|work\s*authoriz\w*|work\s*permit|immigration)\b/i],
  ["authorized_to_work",  /\b(authoriz\w*\s*to\s*work|authorised\s*to\s*work|legally\s*authoriz|eligible\s*to\s*work|permitted\s*to\s*work|right\s*to\s*work|work\s*permit|work\s*authoriz|legal\s*authoriz\w*\s*to\s*work)/i],
  // Company-history questions. Almost always "No", and they appear on 2.1% of required fields.
  // A PAST-EMPLOYMENT marker is mandatory. Without it, "Have you worked with GTM closely?" — a
  // question about a tool the owner uses daily — was answered "No" from the company-history key.
  // The temporal word ("previously", "ever", "before") is what distinguishes "have you worked HERE"
  // from "have you worked WITH this thing".
  ["worked_here_before",  /\b(previously|prior to|ever|before|in the past|formerly)\b[^?]{0,60}\b(work(ed)?|employ(ed|ment)|consult(ed)?|intern(ed)?)\b|\b(work(ed)?|employ(ed|ment)|consult(ed)?|intern(ed)?)\b[^?]{0,40}\b(previously|before|in the past)\b|\b(former|current)\s+employee\s+of\b/i],
  ["relative_at_company", /\b(relative|family member|friend|spouse|partner)\b[^?]{0,50}\b(work|employ)/i],
  // Work-preference questions the survey turned up as commonly required.
  ["willing_hybrid",      /\bhybrid\b|\b\d\s*days?\s*(per|a)\s*week\s*(in|from)\s*(the\s*)?office\b|\bwork\s*from\s*(the\s*)?office\b/i],
  ["work_location_intent",/\bfrom where do you (intend|plan) to work\b|\bwhere (will|would) you be working\b|\bwhere do you intend to work\b/i],
  // Education block (Greenhouse renders these as School / Degree / Discipline / dates).
  ["school",              /\b(school|university|college|institution)\b/i],
  ["degree",              /\bdegree\b/i],
  ["discipline",          /\b(discipline|field of study|major|specialisation|specialization)\b/i],
  ["edu_end_year",        /\b(end|graduation|completion)\s*(date\s*)?year\b/i],
  ["edu_start_year",      /\bstart\s*(date\s*)?year\b/i],
  ["zip_code",            /\b(zip|postal)\s*code\b/i],
  ["preferred_name",      /\bpreferred\s*(first\s*)?name\b|\bname you'?d prefer\b|\bname you go by\b/i],
  ["legal_name",          /\blegal\s*name\b/i],
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

// --- Label hygiene -------------------------------------------------------------------------------
// A survey of 186 real Greenhouse/Lever forms (483 distinct questions) found that 9.4% of everything
// reported as a REQUIRED question was not a question at all — it was a dropdown placeholder
// ("Select…", 91 occurrences), a textarea placeholder ("Type your response", 63), a button caption
// ("Attach", "Apply", "resume_upload_button"), or the first OPTION of a radio group read as if it
// were the group's question ("Yes", 49, with options [Yes|No]). Those must never reach the user as
// something to answer.

/** Placeholder / button text that masquerades as a label. */
const NOISE_LABEL_RE = /^(select\s*\.{0,3}|choose\s*\.{0,3}|type your response|please select|start typing|search|attach|apply|upload|browse|drag and drop|add|none|n\/?a|other|yes|no|true|false|ok|submit|next|continue|—|-|\*)$/i;

/** Machine identifiers: `cards[eab2039f-…][field0]`, `opportunityLocationId`, bare uuids. */
const MACHINE_NAME_RE = /[[\]{}]|^[a-f0-9]{8}-[a-f0-9]{4}-|_(button|input|field|id)$|^[a-z]+(?:[A-Z][a-z]+){1,}$/;

/** Widget status text a container-label read scoops up along with the real question. */
const UI_NOISE_RE = new RegExp([
  /couldn'?t auto-?read( resume)?/.source,
  /analy[sz]ing resume\.*/.source,
  /success!?/.source,
  /attach resume\/?(cv)?/.source,
  /no location found/.source,
  /try entering a different location/.source,
  /loading\.*/.source,
  /drag and drop/.source,
  /or paste/.source,
  /max(imum)? file size[^,.]*/.source,
  /\.pdf,? ?\.docx?/.source,
  /accepted file types[^,.]*/.source,
].join("|"), "gi");

// Leading/trailing punctuation left behind once noise phrases are removed. A trailing "?" is
// DELIBERATELY kept — it's part of the question, and stripping it turned "…require sponsorship?"
// into a statement.
const EDGE_PUNCT_RE = /^[\s.,;:!?/|·—–-]+|[\s.,;:!/|·—–-]+$/g;

/**
 * Turn a raw DOM-derived string into a question worth showing a human, or "" if it isn't one.
 * Returning "" means "the agent could not identify this field" — which is honest, and very
 * different from "the user needs to answer this".
 */
export function cleanLabel(raw) {
  let s = String(raw || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  s = s.replace(/[✱*†‡]+/g, " ");
  s = s.replace(UI_NOISE_RE, " ").replace(/\s+/g, " ").trim();
  s = s.replace(EDGE_PUNCT_RE, "").replace(/\s+/g, " ").trim();
  // A container read can concatenate a question with the following field's text; keep the first
  // sentence/question, which is the part that actually asks something.
  const firstQ = s.match(/^(.{6,200}?\?)/);
  if (firstQ) s = firstQ[1].trim();
  if (!s || s.length < 2) return "";
  if (NOISE_LABEL_RE.test(s)) return "";
  if (MACHINE_NAME_RE.test(s) && !/\s/.test(s)) return "";   // machine names never contain spaces
  return s.slice(0, 160);
}

/** Could the agent identify this field at all? */
export const isIdentifiable = (label) => cleanLabel(label).length > 0;

// --- Consent ------------------------------------------------------------------------------------
// Required on 3.3% of forms, so a form cannot be submitted without them. Owner's decision: routine
// privacy acknowledgements may be ticked; anything authorising a BACKGROUND, REFERENCE or CREDIT
// check is never ticked by the agent and blocks submission instead.
const BG_CHECK_RE = /\b(background\s*(check|verification|screening)|bgv|reference\s*check|credit\s*check|criminal|police\s*clearance|drug\s*(test|screen)|right\s*to\s*work\s*check)\b/i;
const PRIVACY_CONSENT_RE = /\b(privacy\s*(notice|policy|statement)|data\s*(protection|processing)|candidate\s*privacy|acknowledge|acknowledged|i\s*agree|terms|gdpr|consent\s*to\s*(the\s*)?(processing|storage))\b/i;

/** @returns {"privacy"|"background_check"|null} */
export function consentKind(label) {
  const s = String(label || "");
  if (BG_CHECK_RE.test(s)) return "background_check";
  if (PRIVACY_CONSENT_RE.test(s)) return "privacy";
  return null;
}

// --- Essays -------------------------------------------------------------------------------------
// "Why do you want to work at X?" — company-specific, so a stored answer can't be reused. The
// scorer already writes a grounded cover letter for the same role; these get drafted from it and
// shown for editing. NEVER used for pay, notice period or anything legal.
const ESSAY_RE = /^(why\b|what\b.{0,40}(excites|interests|draws|attracts)|tell us|describe|share\b|in your own words|which\b.{0,40}(value|product|feature))/i;

export const isEssayQuestion = (label, kind) =>
  (kind === "textarea" || String(label || "").length > 45) &&
  ESSAY_RE.test(String(label || "").trim()) &&
  !isDemographic(label) &&
  !/salary|ctc|compensation|notice period|visa|sponsor|authoriz/i.test(String(label || ""));

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

// Keys that name a FIELD ("Portfolio URL", "Phone") rather than answer a QUESTION. A long sentence
// that merely contains the word is a question, not that field — "Do you have experience in
// Advertising's portfolio in an ad tech background across represented regions?" was being answered
// with the owner's portfolio URL. Anything past this length is prose and must be read as a question.
const SHORT_LABEL_KEYS = new Set([
  "first_name", "last_name", "full_name", "preferred_name", "legal_name", "email", "phone",
  "location", "city", "country", "zip_code", "linkedin", "website", "github", "twitter",
  "current_company", "current_title", "school", "degree", "discipline",
  "edu_start_year", "edu_end_year", "years_experience",
]);
const MAX_SHORT_LABEL = 60;

/** The canonical answer key for a question label, or null when nothing matches confidently. */
export function classifyQuestion(label) {
  const s = String(label || "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (isDemographic(s)) return null;
  if (asksForeignAuthorization(s)) return null;   // country-specific: a human answers this one
  for (const [key, re] of PATTERNS) {
    if (!re.test(s)) continue;
    if (SHORT_LABEL_KEYS.has(key) && s.length > MAX_SHORT_LABEL) return null;
    return key;
  }
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
  const fills = [], skipped = [], unanswered = [], unreadable = [], consents = [], essays = [];
  for (const f of fields) {
    if (!f || f.kind === "file") continue;                 // files are handled by the driver

    // 1. Could we even identify it? An unidentifiable field is the agent's problem to report, NOT
    //    a question to put in front of the user — that is what produced "cards[eab…][field0]".
    const label = cleanLabel(f.label);
    if (!label) { unreadable.push({ ...f, reason: "no readable label" }); continue; }
    const field = { ...f, label };

    // 2. Consent. Privacy acknowledgements may be ticked; background/reference checks never are.
    const consent = consentKind(label);
    if (consent) {
      const row = { ...field, consent, status: consent === "privacy" ? "filled" : "unanswered", value: consent === "privacy" ? "Yes" : null, key: "consent" };
      consents.push(row);
      if (consent === "privacy") fills.push(row); else unanswered.push(row);
      continue;
    }

    // 3. Essays get drafted from the CV + the role's cover letter, for the owner to edit.
    if (isEssayQuestion(label, f.kind)) {
      const learned = ctx.learned?.[normalizeLabel(label)];
      const row = { ...field, key: "essay", value: learned || null, status: learned ? "filled" : "needs_draft" };
      essays.push(row);
      if (learned) fills.push(row); else unanswered.push(row);
      continue;
    }

    const r = answerFor(field, answers, ctx);
    const row = { ...field, ...r };
    if (r.status === "filled") fills.push(row);
    else if (r.status === "skipped") skipped.push(row);
    else unanswered.push(row);
  }

  // Only REQUIRED items stop the application. An unreadable REQUIRED field is fatal for automation:
  // we can't fill it and we can't sensibly ask about it, so the role goes to hand-apply.
  const blocking = [...unanswered, ...skipped].filter((f) => f.required);
  const blockingUnreadable = unreadable.filter((f) => f.required);
  const answerable = fills.length;
  const total = fills.length + unanswered.length + skipped.length + unreadable.length;
  return {
    fills, skipped, unanswered, unreadable, consents, essays, blocking, blockingUnreadable,
    coverage: total ? Math.round((answerable / total) * 100) : 100,
    canSubmit: blocking.length === 0 && blockingUnreadable.length === 0,
    // Worth attempting at all? A form we can barely read wastes a run and produces the nonsense
    // question list the owner saw. Below this, the dashboard offers the hand-apply packet instead.
    worthAutomating: blockingUnreadable.length === 0 && (total === 0 || answerable / total >= 0.5),
  };
}

/** A short human summary for the dashboard / email. */
export function summarizePlan(plan) {
  const parts = [`${plan.fills.length} field(s) filled (${plan.coverage}% coverage)`];
  if (plan.skipped.length) parts.push(`${plan.skipped.length} demographic question(s) left blank`);
  if (plan.consents.length) parts.push(`${plan.consents.length} consent box(es)`);
  if (plan.essays.length) parts.push(`${plan.essays.length} essay question(s)`);
  if (plan.unreadable.length) parts.push(`${plan.unreadable.length} field(s) the agent couldn't read`);
  if (plan.blocking.length) parts.push(`BLOCKED on ${plan.blocking.length} required question(s)`);
  if (plan.blockingUnreadable.length) parts.push(`BLOCKED: ${plan.blockingUnreadable.length} required field(s) unreadable — apply by hand`);
  return parts.join(" · ");
}
