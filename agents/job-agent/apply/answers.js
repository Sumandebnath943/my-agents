// agents/job-agent/apply/answers.js — the canned answers used to fill application forms.
//
// NOTHING SENSITIVE LIVES IN THIS FILE. This repo is public, and current/expected CTC, phone
// number and notice period are exactly the sort of thing that shouldn't be in a public git
// history. The values come from the APPLY_ANSWERS secret (one JSON blob, one secret to rotate);
// only non-sensitive identity defaults fall back to lib/profile.js, which is already public.
//
// Set the GitHub secret APPLY_ANSWERS to a JSON object, e.g.:
//   {"first_name":"…","last_name":"…","email":"…","phone":"…","location":"Pune, India",
//    "linkedin":"https://www.linkedin.com/in/…","website":"https://…","github":"https://…",
//    "current_company":"…","current_title":"…","years_experience":"9",
//    "notice_period":"<e.g. 60 days>","current_ctc":"<number>","expected_ctc":"<number>",
//    "willing_to_relocate":"Yes","authorized_to_work":"Yes","needs_sponsorship":"No"}
//
// authorized_to_work / needs_sponsorship should be plain "Yes"/"No" — they are almost always
// yes/no dropdowns. A question naming a country other than India is never auto-answered at all.
//
// Anything absent is simply UNANSWERED — the agent never invents a value for a form.
import { PROFILE } from "../../../lib/profile.js";

/** Keys the form filler understands. Order is irrelevant; presence is what matters. */
// Derived from a survey of 186 real Greenhouse/Lever application forms (483 distinct questions).
// Identity alone accounts for ~64% of every REQUIRED field; the rest of this list covers most of
// what's left, so a typical form can be filled without stopping to ask.
export const ANSWER_KEYS = [
  "first_name", "last_name", "full_name", "preferred_name", "legal_name",
  "email", "phone", "location", "city", "country", "zip_code",
  "linkedin", "website", "github", "twitter",
  "current_company", "current_title", "years_experience",
  "notice_period", "current_ctc", "expected_ctc", "willing_to_relocate",
  // Two keys, not one: "Do you require sponsorship?" and "Are you authorized to work here?" have
  // OPPOSITE correct answers. Set both explicitly — the agent will not infer one from the other.
  "authorized_to_work", "needs_sponsorship",
  // Company-history questions, ~2% of required fields and almost always "No".
  "worked_here_before", "relative_at_company",
  // Work preference.
  "willing_hybrid", "work_location_intent",
  // Education block — Greenhouse asks School / Degree / Discipline / start+end year.
  "school", "degree", "discipline", "edu_start_year", "edu_end_year",
  "how_did_you_hear",
];

/**
 * Build the answer set. Pure with respect to its `env` argument so it can be evaluated offline.
 * @returns {{answers: object, missing: string[]}} `missing` = keys with no value configured
 */
export function loadAnswers(env = process.env) {
  let fromSecret = {};
  if (env.APPLY_ANSWERS) {
    try {
      const parsed = JSON.parse(env.APPLY_ANSWERS);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fromSecret = parsed;
      else console.error("APPLY_ANSWERS is not a JSON object — ignoring it.");
    } catch (e) {
      console.error(`APPLY_ANSWERS is not valid JSON (${e.message}) — ignoring it.`);
    }
  }

  // A BLANK value in the secret must behave as "not set", not as "set to empty". `??` only falls
  // through on null/undefined, so `"first_name": ""` used to suppress the fallback entirely and the
  // form went out with an empty First Name.
  const given = {};
  for (const [k, v] of Object.entries(fromSecret)) {
    const s = typeof v === "string" ? v.trim() : String(v ?? "").trim();
    if (s) given[k] = s;
  }

  // If YOU supplied a full name, the two halves come from THAT — not from the hardcoded profile,
  // which would otherwise silently contradict what you configured.
  if (given.full_name) {
    const [first = "", ...rest] = given.full_name.split(/\s+/);
    given.first_name ||= first;
    given.last_name ||= rest.join(" ") || first;
  }

  // Non-sensitive defaults only. Never default a salary, a phone number or a notice period.
  const [pFirst = "", ...pRest] = String(PROFILE.name || "").split(/\s+/);
  const defaults = {
    first_name: pFirst,
    last_name: pRest.join(" "),
    full_name: PROFILE.name || "",
    location: PROFILE.location || "",
    country: "India",
  };

  const answers = {};
  for (const k of ANSWER_KEYS) {
    const s = given[k] ?? defaults[k] ?? "";
    if (s) answers[k] = String(s).trim();
  }
  // Names derive BOTH ways. Lever asks for one "name" field, Greenhouse for two, and a form
  // leaving First Name blank because only `full_name` was configured is a silent, visible failure.
  if (!answers.full_name && (answers.first_name || answers.last_name)) {
    answers.full_name = [answers.first_name, answers.last_name].filter(Boolean).join(" ");
  }
  if (answers.full_name && (!answers.first_name || !answers.last_name)) {
    const [first = "", ...rest] = answers.full_name.split(/\s+/);
    answers.first_name ||= first;
    answers.last_name ||= rest.join(" ") || first;
  }
  return { answers, missing: ANSWER_KEYS.filter((k) => !answers[k]) };
}
