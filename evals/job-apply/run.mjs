// evals/job-apply/run.mjs
// Guards the assisted-apply decision logic — agents/job-agent/apply/{forms,answers}.js.
//
// These cases exist because the failure mode here is expensive and irreversible: a submitted
// application can't be recalled, and a mis-mapped field puts the WRONG SALARY on a real
// application. So the suite leans hardest on two properties:
//   1. "expected CTC" and "current CTC" never get confused with each other.
//   2. Anything we can't answer confidently is reported as unanswered, and a required unanswered
//      question BLOCKS submission rather than being guessed at or left silently blank.
//
// Pure + offline — no browser, no DB, no LLM.
import "../_env.mjs";
import { runCases, isMain } from "../_lib.mjs";
import { detectAts, classifyQuestion, isDemographic, answerFor, planForm, ATS, normalizeLabel, authAnswerableFor,
         cleanLabel, isIdentifiable, consentKind, isEssayQuestion } from "../../agents/job-agent/apply/forms.js";
import { loadAnswers } from "../../agents/job-agent/apply/answers.js";

// Deliberately SYNTHETIC values. This repo is public — the real figures live only in the
// APPLY_ANSWERS secret, and a test fixture is no place for anyone's actual salary.
const ANSWERS = {
  first_name: "Suman", last_name: "Debnath", full_name: "Suman Debnath",
  email: "s@example.com", phone: "9999999999", location: "Pune, India", country: "India",
  linkedin: "https://linkedin.com/in/x", website: "https://example.com",
  current_company: "Acme", current_title: "PMM", years_experience: "9",
  notice_period: "30 days", current_ctc: "111111", expected_ctc: "222222",
  willing_to_relocate: "Yes", authorized_to_work: "Yes", needs_sponsorship: "No",
};

export function run() {
  // --- ATS detection ----------------------------------------------------------------------------
  const atsCases = [
    { id: "greenhouse boards", u: "https://boards.greenhouse.io/postman/jobs/123", want: "greenhouse" },
    { id: "greenhouse job-boards", u: "https://job-boards.greenhouse.io/postman/jobs/7801476003", want: "greenhouse" },
    { id: "lever apply", u: "https://jobs.lever.co/paytm/9eed4fec/apply", want: "lever" },
    { id: "ashby application", u: "https://jobs.ashbyhq.com/notion/05e14247/application", want: "ashby" },
    { id: "naukri is not drivable", u: "https://www.naukri.com/job-listings-pmm-acme-123", want: null },
    { id: "linkedin is not drivable", u: "https://www.linkedin.com/jobs/view/4123456789/", want: null },
    { id: "empty url", u: "", want: null },
  ];
  const atsRes = runCases("job-apply · ATS detection", atsCases, (c) => {
    const got = detectAts(c.u);
    return { ok: got === c.want, note: got === c.want ? "" : `got ${got}` };
  });

  // --- Question classification ------------------------------------------------------------------
  const qCases = [
    // The pair that must never blur together.
    { id: "expected CTC", q: "Expected CTC", want: "expected_ctc" },
    { id: "expected salary", q: "What is your expected salary?", want: "expected_ctc" },
    { id: "salary expectations", q: "Salary expectations", want: "expected_ctc" },
    { id: "desired compensation", q: "Desired compensation", want: "expected_ctc" },
    { id: "current CTC", q: "Current CTC", want: "current_ctc" },
    { id: "present salary", q: "Present salary (per annum)", want: "current_ctc" },
    { id: "current compensation", q: "Your current compensation", want: "current_ctc" },

    { id: "notice period", q: "Notice Period", want: "notice_period" },
    { id: "how soon can you join", q: "How soon can you join?", want: "notice_period" },
    { id: "last working day", q: "Last working day at current employer", want: "notice_period" },
    { id: "years of experience", q: "Total years of experience", want: "years_experience" },
    { id: "how many years", q: "How many years of product marketing experience do you have?", want: "years_experience" },
    { id: "relocate", q: "Are you willing to relocate to Bengaluru?", want: "willing_to_relocate" },
    // Same topic, OPPOSITE answers — these must never collapse into one key.
    { id: "sponsorship question", q: "Will you now or in the future require sponsorship?", want: "needs_sponsorship" },
    { id: "authorized to work (India)", q: "Are you legally authorized to work in India?", want: "authorized_to_work" },
    // REGRESSION (real Postman form): a foreign-country authorization question must never be
    // auto-answered from an India-based canned answer.
    { id: "foreign auth question is NOT answered", q: "Are you authorized to work in Singapore without sponsorship?", want: null },
    { id: "US auth question is NOT answered", q: "Are you legally authorized to work in the United States?", want: null },
    { id: "UK right-to-work is NOT answered", q: "Do you have the right to work in the UK?", want: null },
    { id: "linkedin", q: "LinkedIn Profile", want: "linkedin" },
    { id: "github", q: "GitHub URL", want: "github" },
    { id: "website", q: "Portfolio or website", want: "website" },
    { id: "current company", q: "Current Company", want: "current_company" },
    { id: "current title", q: "Current designation", want: "current_title" },
    // REGRESSION (seen on a real filled form): "Have you worked with GTM Closely?" was answered
    // "No" from the company-history key. GTM here is Google Tag Manager — a tool the owner uses
    // daily. A past-EMPLOYMENT marker is now mandatory.
    { id: "'worked WITH a tool' is NOT company history", q: "Have you worked with GTM Closely? If yes Who are your primary stakeholders", want: null },
    { id: "'worked with Figma the tool' is not company history", q: "Have you worked with Figma?", want: null },
    { id: "'previously worked at' IS company history", q: "Have you previously worked at Figma?", want: "worked_here_before" },
    { id: "'ever worked for' IS company history", q: "Have you ever worked for Groww?", want: "worked_here_before" },
    { id: "'employed by ... before' IS company history", q: "Have you been employed by Pendo before?", want: "worked_here_before" },
    // REGRESSION: a long question merely CONTAINING "portfolio" was answered with the portfolio URL.
    { id: "long question containing 'portfolio' is not the website field", q: "Do you have experience in Advertising's portfolio in an ad tech background across represented regions?", want: null },
    { id: "short 'Portfolio URL' still maps", q: "Portfolio URL", want: "website" },
    { id: "long question containing 'phone' is not the phone field", q: "Describe a time you had to handle a difficult customer phone call and what you learned", want: null },
    { id: "how did you hear", q: "How did you hear about this role?", want: "how_did_you_hear" },
    { id: "first name", q: "First Name", want: "first_name" },
    { id: "last name", q: "Last Name", want: "last_name" },
    { id: "bare 'Name'", q: "Name", want: "full_name" },
    { id: "email", q: "Email", want: "email" },
    { id: "phone", q: "Phone", want: "phone" },
    { id: "location", q: "Current location", want: "location" },

    // Must NOT be classified — no confident answer exists.
    { id: "essay question unmatched", q: "Why do you want to work here?", want: null },
    { id: "case question unmatched", q: "Describe a product launch you led", want: null },
    { id: "empty label", q: "", want: null },
    { id: "gender not classified", q: "Gender", want: null },
    { id: "ethnicity not classified", q: "Race / Ethnicity", want: null },
    { id: "veteran not classified", q: "Veteran status", want: null },
    { id: "disability not classified", q: "Disability status", want: null },
  ];
  const qRes = runCases("job-apply · question classification", qCases, (c) => {
    const got = classifyQuestion(c.q);
    return { ok: got === c.want, note: got === c.want ? "" : `got ${got}` };
  });

  const demoCases = [
    { id: "gender is demographic", q: "Gender", want: true },
    { id: "hispanic is demographic", q: "Are you Hispanic or Latino?", want: true },
    { id: "pronouns are demographic", q: "Preferred pronouns", want: true },
    { id: "notice period is not", q: "Notice period", want: false },
    { id: "experience is not", q: "Years of experience", want: false },
    // Stems, not whole words — these all failed when the pattern had a trailing \b.
    { id: "ethnicity (suffix) is demographic", q: "Ethnicity", want: true },
    { id: "disability (suffix) is demographic", q: "Disability status", want: true },
    { id: "genders (suffix) is demographic", q: "Gender identity", want: true },
    { id: "veteran status is demographic", q: "Protected veteran status", want: true },
    { id: "'package' is not an age question", q: "Expected package", want: false },
    { id: "'manager' is not demographic", q: "Have you been a manager?", want: false },
    // REGRESSION (real Lever form): demographics also appear as individual radio OPTIONS whose
    // label is the answer itself, not the question.
    { id: "option label 'Female'", q: "Female", want: true },
    { id: "option label 'Non-binary'", q: "Non-binary", want: true },
    { id: "option label 'White / Caucasian'", q: "White / Caucasian", want: true },
    { id: "option label 'Asian'", q: "Asian", want: true },
    { id: "age bracket '18-20'", q: "18-20", want: true },
    { id: "age bracket '60 or older'", q: "60 or older", want: true },
    { id: "'prefer not to say'", q: "Prefer not to say", want: true },
  ];
  const demoRes = runCases("job-apply · demographic questions are left to the human", demoCases, (c) => {
    const got = isDemographic(c.q);
    return { ok: got === c.want, note: got === c.want ? "" : `got ${got}` };
  });

  // --- answerFor --------------------------------------------------------------------------------
  const aCases = [
    { id: "known question fills", f: { label: "Expected CTC" }, check: (r) => r.status === "filled" && r.value === "222222" },
    { id: "current CTC gets the CURRENT value", f: { label: "Current CTC" }, check: (r) => r.value === "111111" },
    { id: "demographic is skipped, not guessed", f: { label: "Gender" }, check: (r) => r.status === "skipped" && r.value === null },
    { id: "unknown question is unanswered", f: { label: "Why this company?" }, check: (r) => r.status === "unanswered" },
    { id: "known question with no configured answer is unanswered", f: { label: "GitHub" }, answers: {}, check: (r) => r.status === "unanswered" && r.key === "github" },
    // REGRESSION (real Greenhouse form): "Current role" is a CHECKBOX. Ticking it because we hold
    // a job-title string for that key would be a fabricated answer.
    { id: "checkbox is not filled from a free-text answer", f: { label: "Current title", kind: "checkbox" }, check: (r) => r.status === "unanswered" },
    { id: "checkbox IS filled from a yes/no answer", f: { label: "Are you willing to relocate?", kind: "checkbox" }, check: (r) => r.status === "filled" && r.value === "Yes" },
    { id: "foreign authorization is unanswered, not skipped", f: { label: "Authorized to work in the US?" }, check: (r) => r.status === "unanswered" },
  ];
  const aRes = runCases("job-apply · answerFor", aCases, (c) => {
    const got = answerFor(c.f, c.answers ?? ANSWERS, c.ctx);
    return { ok: !!c.check(got), note: c.check(got) ? "" : JSON.stringify(got) };
  });

  // --- authorization polarity + geo-awareness ---------------------------------------------------
  // REGRESSION: "Do you require work authorization?" was answered "Yes" — i.e. "yes, I need
  // sponsorship". The polarity test is the require-VERB, not the presence of the word sponsorship.
  const IN = { geo: "india_onsite" }, GLOBAL = { geo: "global_remote" };
  const authCases = [
    { id: "'require work authorization' is a SPONSORSHIP question", q: "Do you require work authorization?", ctx: IN, want: "No" },
    { id: "'require sponsorship' -> No", q: "Will you now or in the future require sponsorship?", ctx: IN, want: "No" },
    { id: "'need sponsorship for a visa' -> No", q: "Will you, at any point in the future, need sponsorship for a visa?", ctx: IN, want: "No" },
    { id: "'immigration sponsorship' -> No", q: "Do you now or in the future require immigration sponsorship?", ctx: IN, want: "No" },
    { id: "'authorized to work' -> Yes", q: "Are you legally authorized to work in India?", ctx: IN, want: "Yes" },
    { id: "'current country' answered for an India role", q: "Are you legally authorized to work in the current country?", ctx: IN, want: "Yes" },
    { id: "'eligible to work in this country' -> Yes", q: "Are you eligible to work in this country?", ctx: IN, want: "Yes" },
    // Geo-aware: the same wording is ambiguous on a globally-remote role at a foreign employer.
    { id: "'current country' BLOCKED on a global-remote role", q: "Are you legally authorized to work in the current country?", ctx: GLOBAL, want: null },
    { id: "sponsorship BLOCKED on a global-remote role", q: "Do you require work authorization?", ctx: GLOBAL, want: null },
    { id: "India-named question still answered on global-remote", q: "Are you authorized to work in India?", ctx: GLOBAL, want: null },
    // A named foreign country is never answered, whatever the role's geo.
    { id: "Singapore BLOCKED even on an India role", q: "Are you authorized to work in Singapore without sponsorship?", ctx: IN, want: null },
    { id: "visa status is too vague to answer", q: "What is your visa status?", ctx: IN, want: null },
  ];
  const authRes = runCases("job-apply · authorization polarity + geo gate", authCases, (c) => {
    const r = answerFor({ label: c.q, required: true }, ANSWERS, c.ctx);
    const got = r.status === "filled" ? r.value : null;
    return { ok: got === c.want, note: got === c.want ? "" : `got ${got} (${r.status})` };
  });

  // --- learned answers ---------------------------------------------------------------------------
  const learned = { [normalizeLabel("Why do you want to work here?")]: "Because X." };
  const learnCases = [
    { id: "a learned answer unblocks an unknown question", f: { label: "Why do you want to work here?" }, ctx: { learned }, check: (r) => r.status === "filled" && r.value === "Because X." },
    { id: "matches despite a required marker", f: { label: "Why do you want to work here?*" }, ctx: { learned }, check: (r) => r.status === "filled" },
    { id: "matches despite a parenthetical", f: { label: "Why do you want to work here? (250 words)" }, ctx: { learned }, check: (r) => r.status === "filled" },
    { id: "a different question still blocks", f: { label: "Describe your biggest launch" }, ctx: { learned }, check: (r) => r.status === "unanswered" },
    { id: "a learned answer overrides the foreign-country block", f: { label: "Authorized to work in Singapore?" }, ctx: { learned: { [normalizeLabel("Authorized to work in Singapore?")]: "No" } }, check: (r) => r.status === "filled" && r.value === "No" },
  ];
  const learnRes = runCases("job-apply · learned answers", learnCases, (c) => {
    const got = answerFor(c.f, ANSWERS, c.ctx);
    return { ok: !!c.check(got), note: c.check(got) ? "" : JSON.stringify(got) };
  });

  const normCases = [
    { id: "strips required markers", a: "Expected CTC*", b: "Expected CTC" },
    { id: "strips parentheticals", a: "Notice period (in days)", b: "Notice period" },
    { id: "strips the Lever star", a: "Phone ✱", b: "Phone" },
    { id: "case and punctuation insensitive", a: "CURRENT CTC:", b: "current ctc" },
    { id: "filler words dropped", a: "What is your expected CTC?", b: "expected CTC" },
  ];
  const normRes = runCases("job-apply · label normalization (answer reuse)", normCases, (c) => {
    const x = normalizeLabel(c.a), y = normalizeLabel(c.b);
    return { ok: x === y && !!x, note: x === y ? "" : `"${x}" != "${y}"` };
  });

  // --- planForm: the submission interlock -------------------------------------------------------
  const baseFields = [
    { label: "First Name", required: true, selector: "#first_name" },
    { label: "Email", required: true, selector: "#email" },
    { label: "Expected CTC", required: true, selector: "#q1" },
    { label: "Gender", required: false, selector: "#q2" },
  ];
  const planCases = [
    { id: "all answerable → can submit", fields: baseFields, check: (p) => p.canSubmit && p.fills.length === 3 },
    { id: "optional demographic doesn't block", fields: baseFields, check: (p) => p.skipped.length === 1 && p.blocking.length === 0 },
    { id: "REQUIRED unknown question BLOCKS", fields: [...baseFields, { label: "Why do you want this job?", required: true, selector: "#q3" }],
      check: (p) => !p.canSubmit && p.blocking.length === 1 },
    { id: "optional unknown question does NOT block", fields: [...baseFields, { label: "Why do you want this job?", required: false, selector: "#q3" }],
      check: (p) => p.canSubmit && p.unanswered.length === 1 },
    { id: "REQUIRED demographic blocks rather than being answered", fields: [{ label: "Gender", required: true, selector: "#q2" }],
      check: (p) => !p.canSubmit && p.blocking.length === 1 },
    { id: "missing answer for a known key blocks when required",
      fields: [{ label: "GitHub URL", required: true, selector: "#q4" }], answers: {},
      check: (p) => !p.canSubmit },
    { id: "file inputs are the driver's job, not the planner's",
      fields: [{ label: "Resume", required: true, kind: "file", selector: "#resume" }],
      check: (p) => p.fills.length === 0 && p.canSubmit },
    { id: "empty form is submittable", fields: [], check: (p) => p.canSubmit && p.fills.length === 0 },
  ];
  const planRes = runCases("job-apply · form plan + submission interlock", planCases, (c) => {
    const p = planForm(c.fields, c.answers ?? ANSWERS);
    const ok = !!c.check(p);
    return { ok, note: ok ? "" : `canSubmit=${p.canSubmit} fills=${p.fills.length} blocking=${JSON.stringify(p.blocking.map((b) => b.label))}` };
  });

  // --- answers loading --------------------------------------------------------------------------
  const loadCases = [
    { id: "reads the APPLY_ANSWERS secret", env: { APPLY_ANSWERS: '{"expected_ctc":"222222"}' }, check: (r) => r.answers.expected_ctc === "222222" },
    { id: "invalid JSON degrades, never throws", env: { APPLY_ANSWERS: "{not json" }, check: (r) => !r.answers.expected_ctc },
    { id: "a JSON array is rejected", env: { APPLY_ANSWERS: '["nope"]' }, check: (r) => !r.answers.expected_ctc },
    { id: "absent secret still yields public defaults", env: {}, check: (r) => !!r.answers.full_name && !!r.answers.country },
    { id: "NEVER invents a salary", env: {}, check: (r) => !r.answers.expected_ctc && !r.answers.current_ctc },
    { id: "NEVER invents a notice period", env: {}, check: (r) => !r.answers.notice_period },
    { id: "NEVER invents a work-authorization answer", env: {}, check: (r) => !r.answers.authorized_to_work && !r.answers.needs_sponsorship },
    { id: "missing keys are reported", env: {}, check: (r) => r.missing.includes("expected_ctc") },
    { id: "blank values count as missing", env: { APPLY_ANSWERS: '{"phone":"   "}' }, check: (r) => r.missing.includes("phone") },
    // A form leaving First Name blank because only full_name was configured is a visible failure.
    { id: "first/last derive FROM full_name", env: { APPLY_ANSWERS: '{"full_name":"Suman Debnath"}' },
      check: (r) => r.answers.first_name === "Suman" && r.answers.last_name === "Debnath" },
    { id: "explicit first_name is never overwritten", env: { APPLY_ANSWERS: '{"full_name":"A B","first_name":"Zed"}' },
      check: (r) => r.answers.first_name === "Zed" },
    { id: "single-word full_name still yields both", env: { APPLY_ANSWERS: '{"full_name":"Cher"}' },
      check: (r) => r.answers.first_name === "Cher" && r.answers.last_name === "Cher" },
  ];
  const loadRes = runCases("job-apply · answer loading (nothing sensitive is defaulted)", loadCases, (c) => {
    const got = loadAnswers(c.env);
    return { ok: !!c.check(got), note: c.check(got) ? "" : JSON.stringify(got.answers).slice(0, 120) };
  });

  const atsCfgCases = [
    { id: "every ATS declares a submit selector", check: () => Object.values(ATS).every((a) => !!a.submit) },
    { id: "every ATS declares a resume input", check: () => Object.values(ATS).every((a) => !!a.resumeInput) },
    { id: "ashby is marked low confidence (it is a SPA)", check: () => ATS.ashby.confidence === "low" },
  ];
  const cfgRes = runCases("job-apply · ATS config sanity", atsCfgCases, (c) => ({ ok: !!c.check() }));

  // --- label hygiene ----------------------------------------------------------------------------
  // Grounded in a survey of 186 real Greenhouse/Lever forms: 9.4% of everything reported as a
  // REQUIRED question was a placeholder, a button caption, a machine name, or the first OPTION of
  // a radio group. None of those may ever reach the owner as something to answer.
  const labelCases = [
    { id: "dropdown placeholder 'Select...'", raw: "Select...", want: "" },
    { id: "textarea placeholder", raw: "Type your response", want: "" },
    { id: "button caption 'Attach'", raw: "Attach", want: "" },
    { id: "button caption 'Apply'", raw: "Apply", want: "" },
    { id: "radio option read as question", raw: "Yes", want: "" },
    { id: "machine name with brackets", raw: "cards[eab2039f-b7ab-4b2e-9e72-c0be6e087013][field0]", want: "" },
    { id: "camelCase machine id", raw: "opportunityLocationId", want: "" },
    { id: "upload button name", raw: "resume_upload_button", want: "" },
    { id: "empty", raw: "", want: "" },
    { id: "strips the required marker", raw: "Expected CTC ✱", want: "Expected CTC" },
    { id: "strips widget status text", raw: "Current location ✱No location found. Try entering a different locationLoading", want: "Current location" },
    { id: "strips resume widget noise", raw: "Resume/CV ✱ATTACH RESUME/CVCouldn't auto-read resume.Analyzing resume...Success!", want: "Resume/CV" },
    { id: "keeps a real question", raw: "Will you now or in the future require sponsorship?", want: "Will you now or in the future require sponsorship?" },
    { id: "keeps a multi-word label", raw: "Current Company", want: "Current Company" },
  ];
  const labelRes = runCases("job-apply · label hygiene (real survey findings)", labelCases, (c) => {
    const got = cleanLabel(c.raw);
    return { ok: got === c.want, note: got === c.want ? "" : `got "${got}"` };
  });

  // --- consent ------------------------------------------------------------------------------------
  const consentCases = [
    { id: "privacy notice -> tickable", q: "Applicant Privacy Notice", want: "privacy" },
    { id: "acknowledge privacy policy -> tickable", q: "Please acknowledge that you've read and understand our Recruitment Privacy Policy", want: "privacy" },
    { id: "I acknowledge -> tickable", q: "I acknowledge", want: "privacy" },
    { id: "BACKGROUND CHECK -> never ticked", q: "Do you provide your consent for us to conduct your background verification (BGV) and reference checks?", want: "background_check" },
    { id: "reference check -> never ticked", q: "I consent to a reference check", want: "background_check" },
    { id: "credit check -> never ticked", q: "Do you consent to a credit check?", want: "background_check" },
    { id: "an ordinary question is not consent", q: "Current Company", want: null },
  ];
  const consentRes = runCases("job-apply · consent (privacy yes, background checks never)", consentCases, (c) => {
    const got = consentKind(c.q);
    return { ok: got === c.want, note: got === c.want ? "" : `got ${got}` };
  });

  // --- essays -------------------------------------------------------------------------------------
  const essayCases = [
    { id: "why do you want to work here", q: "Why do you want to work at Figma?", kind: "textarea", want: true },
    { id: "what excites you", q: "What excites you most about this opportunity?", kind: "textarea", want: true },
    { id: "which value resonates", q: "Which of our values resonates most with you and why?", kind: "textarea", want: true },
    { id: "salary is NEVER an essay", q: "Why do you think you deserve this expected CTC?", kind: "textarea", want: false },
    { id: "visa is NEVER an essay", q: "Why do you require visa sponsorship?", kind: "textarea", want: false },
    { id: "demographic is NEVER an essay", q: "Describe your gender identity", kind: "textarea", want: false },
    { id: "a short text field is not an essay", q: "Current Company", kind: "text", want: false },
  ];
  const essayRes = runCases("job-apply · essay detection", essayCases, (c) => {
    const got = !!isEssayQuestion(c.q, c.kind);
    return { ok: got === c.want, note: got === c.want ? "" : `got ${got}` };
  });

  // --- the whole plan, with real-world field shapes ------------------------------------------------
  const realish = [
    { label: "First Name", required: true, kind: "text", selector: "#first_name" },
    { label: "Email", required: true, kind: "text", selector: "#email" },
    { label: "Phone", required: true, kind: "text", selector: "#phone" },
    { label: "Select...", required: true, kind: "combobox", selector: "#c1" },
    { label: "cards[eab2039f][field0]", required: true, kind: "text", selector: "#c2" },
    { label: "Gender", required: false, kind: "combobox", selector: "#g" },
    { label: "Applicant Privacy Notice", required: true, kind: "checkbox", selector: "#p" },
  ];
  const planRealCases = [
    { id: "unreadable fields are NOT presented as questions",
      check: (p) => p.blocking.every((f) => !/\[|Select\.\.\./.test(f.label)) },
    { id: "unreadable fields are reported separately", check: (p) => p.unreadable.length === 2 },
    { id: "a REQUIRED unreadable field blocks submission", check: (p) => !p.canSubmit && p.blockingUnreadable.length === 2 },
    { id: "and makes the form not worth automating", check: (p) => p.worthAutomating === false },
    { id: "privacy consent is ticked", check: (p) => p.consents.some((c) => c.consent === "privacy" && c.value === "Yes") },
    { id: "coverage is reported", check: (p) => typeof p.coverage === "number" && p.coverage > 0 },
  ];
  const planRealRes = runCases("job-apply · plan on real-world field shapes", planRealCases, (c) => {
    const p = planForm(realish, ANSWERS, { geo: "india_onsite" });
    const ok = !!c.check(p);
    return { ok, note: ok ? "" : `coverage=${p.coverage} unreadable=${p.unreadable.length} blocking=${JSON.stringify(p.blocking.map((f) => f.label))}` };
  });

  const bgCase = runCases("job-apply · background-check consent blocks", [
    { id: "BGV consent is never auto-ticked and blocks", check: () => {
      const p = planForm([{ label: "Do you consent to background verification (BGV)?", required: true, kind: "checkbox", selector: "#b" }], ANSWERS, {});
      return !p.canSubmit && p.consents[0].consent === "background_check" && p.consents[0].value === null;
    } },
  ], (c) => ({ ok: !!c.check() }));

  return [atsRes, qRes, demoRes, aRes, authRes, learnRes, normRes, planRes, loadRes, cfgRes, labelRes, consentRes, essayRes, planRealRes, bgCase];
}

if (isMain(import.meta.url)) {
  const results = run();
  if (results.reduce((n, r) => n + r.fail, 0)) process.exit(1);
}
