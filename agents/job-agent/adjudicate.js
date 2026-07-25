// agents/job-agent/adjudicate.js — the LLM half of the geo gate.
//
// geo.js decides most roles from text alone. What's left is genuinely ambiguous: a blank location,
// or a location like "HQ" / "Global Hub" that names no country. Those must NOT pass silently (that
// was the old `!l ||` bug), so they come here — batched into ONE call for the whole run rather than
// one call per role, because this runs before scoring and must stay nearly free.
//
// Fail-safe direction matters: if the model errors, returns junk, or omits a row, the role is
// treated as NOT eligible. An irrelevant role reaching your inbox is the exact problem we're
// fixing; a borderline role being held back is recoverable (it shows on the dashboard as filtered).
import { callLLM, parseJson } from "../../lib/llm.js";

/** Compact one job into the few lines the adjudicator needs. */
const brief = (j, i) =>
  `#${i}
title: ${j.title || "?"}
company: ${j.company || "?"}
location: ${j.location || "(blank)"}
excerpt: ${String(j.description || "").replace(/\s+/g, " ").slice(0, 700)}`;

/**
 * Decide India-eligibility for roles geo.js couldn't call.
 * @param {Array<object>} jobs
 * @returns {Promise<Array<{eligible: boolean, reason: string}>>} same order/length as `jobs`
 */
export async function adjudicateGeo(jobs, { batchSize = 10 } = {}) {
  const verdicts = jobs.map(() => ({ eligible: false, reason: "geo undetermined — held back" }));
  if (!jobs.length) return verdicts;

  for (let start = 0; start < jobs.length; start += batchSize) {
    const batch = jobs.slice(start, start + batchSize);
    let rows;
    try {
      const out = await callLLM(
        `You decide whether a job can legally and practically be held by someone who LIVES IN INDIA and will not relocate abroad.

Answer "yes" only when an India-resident could hold the role: the job is located in India, OR it is remote and open to India (worldwide/global/APAC/"anywhere"), OR the employer clearly hires in India.
Answer "no" when the role is tied to another country: located abroad, remote but restricted to another region, or requiring work authorization India-residents don't have.
If the posting genuinely does not say, answer "no" — do not guess generously.

Return ONLY JSON: {"verdicts":[{"i":<the #number>,"eligible":true|false,"why":"<8 words max>"}]}

${batch.map((j, k) => brief(j, start + k)).join("\n\n")}`,
        { json: true },
      );
      rows = parseJson(out)?.verdicts;
    } catch (e) {
      console.error(`job-agent: geo adjudication batch failed (${e.message}) — holding ${batch.length} role(s) back.`);
      continue;                                    // verdicts stay at the safe default
    }
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      const i = Number(r?.i);
      if (!Number.isInteger(i) || i < start || i >= start + batch.length) continue;
      verdicts[i] = {
        eligible: r.eligible === true,
        reason: String(r.why || "").slice(0, 90) || (r.eligible === true ? "India-eligible" : "not open to India"),
      };
    }
  }
  return verdicts;
}
