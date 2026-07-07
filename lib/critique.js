// lib/critique.js
// Self-critique / reflection pass: one extra LLM call that checks a draft against criteria and,
// when asked, returns an improved version. Uses callPrivate so it inherits the provider fallback
// chain. BEST-EFFORT BY DESIGN: any failure (or an empty revision) returns the ORIGINAL text
// unchanged — a critic problem must never block or degrade the agent's primary output.
import { callPrivate, parseJson } from "./llm.js";

/**
 * @param {string} text                      the draft to review
 * @param {object} opts
 * @param {string} opts.role                 one line telling the critic what it's reviewing
 * @param {string} opts.criteria             the bar the draft must clear (bullet list works well)
 * @param {boolean} [opts.revise=true]       if false, only score — never rewrite
 * @param {number} [opts.temperature=0.3]
 * @returns {Promise<{ok: boolean, issues: string[], text: string, error?: string}>}
 */
export async function critique(text, { role = "", criteria = "", revise = true, temperature = 0.3 } = {}) {
  if (!text || !String(text).trim()) return { ok: true, issues: [], text };
  try {
    const out = await callPrivate(
      [
        { role: "system", content: `You are a sharp, honest editor. ${role} Reply ONLY with JSON.` },
        {
          role: "user",
          content:
`Evaluate the DRAFT against these criteria:
${criteria}

Return JSON {"ok": true|false, "issues": ["short issue", ...], "revised": "an improved version that fixes the issues — SAME language, format and constraints; return the draft unchanged if it is already good"}.

DRAFT:
${text}`,
        },
      ],
      { json: true, temperature }
    );
    const j = parseJson(out);
    const revised = revise && typeof j.revised === "string" && j.revised.trim() ? j.revised.trim() : text;
    return { ok: j.ok !== false, issues: Array.isArray(j.issues) ? j.issues : [], text: revised };
  } catch (e) {
    return { ok: true, issues: [], text, error: e.message }; // never block the primary output
  }
}
