// agents/job-agent/index.js — Apply-Ready Job Agent.
// Gather (public ATS + remote boards) -> DETERMINISTIC screen (title band, company block, freshness,
// comp floor, India-eligibility) -> LLM adjudication for the few roles geo can't call from text ->
// dedupe against the jobs table -> score + tailor a cover letter -> email a ranked, apply-ready packet.
//
// GEOGRAPHY IS A HARD GATE. You live in India, so a role only counts if an India resident can hold
// it. "Remote" alone proves nothing — see geo.js. Nothing reaches the LLM until it has cleared that
// gate, which is also why the scoring cap can be generous: it only ever sees survivors.
//
// NO AUTO-SUBMIT: you click apply (compliant, and better on senior roles). The CV comes from the
// CV_TEXT secret (kept private — this repo is public); a local agents/job-agent/cv.md is a fallback.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { MIN_FIT, SCORE_CAP, EMAIL_CAP, GREENHOUSE, LEVER, ASHBY } from "./config.js";
import { greenhouse, lever, ashby, remoteBoards } from "./ats.js";
import { portalJobs } from "./portals.js";
import { screen } from "./filter.js";
import { adjudicateGeo } from "./adjudicate.js";
import { dedupe, fingerprint, summarizeDedupe } from "./dedupe.js";
import { callLLM, parseJson } from "../../lib/llm.js";
import { critique } from "../../lib/critique.js";
import { notifyEmail } from "../../lib/notify.js";
import { renderEmail, mdToHtml } from "../../lib/email-template.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));

let CV = process.env.CV_TEXT || "";
if (!CV) { try { CV = readFileSync(new URL("./cv.md", import.meta.url), "utf8"); } catch {} }
if (!CV) { console.error("No CV found. Set the CV_TEXT secret (recommended for this public repo) or add agents/job-agent/cv.md."); process.exit(1); }

// 1) Gather from every source.
let all = [];
for (const t of GREENHOUSE) { try { all.push(...(await greenhouse(t))); } catch {} }
for (const s of LEVER)      { try { all.push(...(await lever(s))); } catch {} }
for (const n of ASHBY)      { try { all.push(...(await ashby(n))); } catch {} }
all.push(...(await remoteBoards()));
const atsCount = all.length;
// Portals are where the Indian market actually is — the ATS boards above are overwhelmingly US
// companies. Best-effort: a portal failure (no Tavily key, spent budget, a portal blocking us)
// leaves the ATS results untouched rather than failing the run.
try { all.push(...(await portalJobs())); } catch (e) { console.error(`portals: sourcing failed — ${e.message}`); }
console.log(`Gathered ${all.length} postings (${atsCount} ATS + ${all.length - atsCount} portal).`);

// 2) Deterministic screen — everything below happens BEFORE any LLM call.
const rejects = {};   // stage -> count, so a run tells you what it threw away and why
const passed = [];
const undecided = [];
for (const j of all) {
  const v = screen(j);
  if (v.pass) { passed.push({ ...j, screen: v }); continue; }
  if (v.needsGeoCheck) { undecided.push({ ...j, screen: v }); continue; }
  rejects[v.stage] = (rejects[v.stage] || 0) + 1;
}
console.log(`Screened: ${passed.length} clear, ${undecided.length} need a geo call, rejected ${JSON.stringify(rejects)}.`);

// 3) Adjudicate the ambiguous ones in one batched call. Anything the model won't confirm as
// India-eligible stays out — silence is not a pass.
if (undecided.length) {
  const verdicts = await adjudicateGeo(undecided);
  undecided.forEach((j, i) => {
    if (verdicts[i]?.eligible) {
      j.screen.geo = { ...j.screen.geo, eligible: true, reason: `LLM: ${verdicts[i].reason}` };
      passed.push(j);
    } else {
      rejects.geo_llm = (rejects.geo_llm || 0) + 1;
    }
  });
  console.log(`Adjudicated ${undecided.length}: ${passed.length} total now clear.`);
}
if (!passed.length) { console.log("Nothing cleared the screen."); process.exit(0); }

// 4a) Collapse the SAME role arriving from several sources. Must happen before scoring — each
// duplicate would otherwise cost its own LLM call and its own cover letter.
const { unique: deduped, dropped } = dedupe(passed);
if (dropped.length) console.log(`Dedupe: ${summarizeDedupe(dropped)}.`);

// 4b) Dedupe against what we've already surfaced — one query per key, not one per role.
// Two keys, because they catch different things: job_hash catches the identical posting seen
// again, fingerprint catches the same role we already have from a different site.
const withKeys = deduped.map((j) => ({
  ...j,
  hash: createHash("sha1").update(j.url || `${j.title}@${j.company}`).digest("hex"),
  fingerprint: j.fingerprint || fingerprint(j) || null,
}));
const seenHashes = new Set();
const seenPrints = new Set();
for (let i = 0; i < withKeys.length; i += 200) {
  const batch = withKeys.slice(i, i + 200);
  const { data } = await db.from("jobs").select("job_hash").in("job_hash", batch.map((j) => j.hash));
  for (const r of data || []) seenHashes.add(r.job_hash);
  const prints = batch.map((j) => j.fingerprint).filter(Boolean);
  if (prints.length) {
    // Best-effort: before sql/jobs_dedupe.sql is run the column doesn't exist, and the agent
    // simply behaves as it did before — URL dedupe only.
    const { data: fp, error } = await db.from("jobs").select("fingerprint").in("fingerprint", prints);
    if (error) console.error(`Dedupe: fingerprint column unavailable (${error.message}) — run sql/jobs_dedupe.sql.`);
    for (const r of fp || []) if (r.fingerprint) seenPrints.add(r.fingerprint);
  }
}
const fresh = withKeys.filter((j) => !seenHashes.has(j.hash) && !(j.fingerprint && seenPrints.has(j.fingerprint)));
if (!fresh.length) { console.log("No new matching roles."); process.exit(0); }
console.log(`${fresh.length} new role(s) to score.`);

// 5) Score + tailor each (cap per run to stay within free limits — survivors only).
const results = [];
for (const j of fresh.slice(0, SCORE_CAP)) {
  let scored;
  try {
    const out = await callLLM(
      `You are my job-application assistant. Given my CV and this job, return JSON:
{"fit":0-100 how well I match,"seniority_match":"under"|"match"|"over","reasons":"1-2 lines","why_not":"the single biggest gap, 1 line","company":"the hiring company's name as stated in the posting (use the one given if it is already known)","cover_letter":"a tailored 150-200 word cover letter referencing THIS company and role, in a confident, specific, non-generic voice","emphasize":"which of my CV points to foreground"}.
MY CV:\n${CV.slice(0, 6000)}\n\nJOB: ${j.title} @ ${j.company || "(company not stated — read it from the posting)"} (${j.location})\n${j.description}`,
      { json: true },
    );
    scored = parseJson(out);
  } catch { continue; }
  // For roles that clear the bar (the ones I'll actually see), self-critique the cover letter for
  // factual grounding — no fabricated metrics/titles/employers — before storing/emailing it.
  // Best-effort: a critic failure leaves the letter as generated. Gated on fit to stay within limits.
  if (scored.fit >= MIN_FIT) {
    const crit = await critique(scored.cover_letter, {
      role: "You fact-check job cover letters against the candidate's CV.",
      criteria:
`- Every claim is grounded ONLY in the CV below — NO fabricated metrics, titles, employers, or dates
- Specific to THIS company and role, not a generic template
- Confident and concise (150-200 words), no clichés
CV:\n${CV.slice(0, 3000)}`,
    });
    scored.cover_letter = crit.text;
  }
  // Persist everything the screen and the scorer learned — that's what the dashboard filters,
  // sorts and triages on. If sql/jobs_upgrade.sql hasn't been run yet the wide insert fails on an
  // unknown column, so fall back to the original column set rather than losing the role entirely.
  const sal = j.screen?.salary || {};
  // Portal postings often carry no company name in the search result, so the scorer reads it off
  // the description. Never overwrite a name a source actually gave us.
  j.company = j.company || String(scored.company || "").slice(0, 80) || "(unknown)";
  // Portal roles often have no company until the scorer reads it off the description, so their
  // fingerprint can only be computed now. Re-check it here or the same role from three portals
  // would still land three times.
  if (!j.fingerprint) {
    j.fingerprint = fingerprint(j) || null;
    if (j.fingerprint && seenPrints.has(j.fingerprint)) {
      console.log(`Skipping "${j.title} @ ${j.company}" — already have it from another source.`);
      continue;
    }
  }
  if (j.fingerprint) seenPrints.add(j.fingerprint);
  const row = {
    title: j.title, company: j.company, location: j.location, url: j.url,
    apply_url: j.apply_url, ats: j.ats, fit: scored.fit,
    cover_letter: scored.cover_letter, job_hash: j.hash,
  };
  const { error: insErr } = await db.from("jobs").insert({
    ...row,
    source: j.source || j.ats,
    fingerprint: j.fingerprint,
    family: j.screen?.family || null,
    geo_class: j.screen?.geo?.geo || null,
    geo_reason: j.screen?.geo?.reason || null,
    why_matched: j.screen?.reason || null,
    flags: j.screen?.flags || [],
    posted_at: j.posted_at || null,
    salary_text: j.salary || null,
    salary_min_lpa: sal.minLpa ?? null,
    salary_max_lpa: sal.maxLpa ?? null,
    seniority_match: scored.seniority_match || null,
    fit_reasons: scored.reasons || null,
    why_not: scored.why_not || null,
    emphasize: scored.emphasize || null,
  });
  if (insErr) {
    console.error(`job-agent: wide insert failed (${insErr.message}) — falling back. Run sql/jobs_upgrade.sql.`);
    await db.from("jobs").insert(row);
  }
  if (scored.fit >= MIN_FIT) results.push({ ...j, ...scored });
}

if (!results.length) { console.log("New roles found but none above fit threshold."); process.exit(0); }

// 6) One email packet, best fit first — each with a direct apply link + cover letter.
results.sort((a, b) => b.fit - a.fit);
const shown = results.slice(0, EMAIL_CAP);
const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
const rejectLine = Object.entries(rejects).map(([k, n]) => `${n} ${k}`).join(" · ") || "none";
const blocks = [
  { type: "tiles", items: [
    { ramp: "green", label: "New roles", value: String(results.length) },
    { ramp: "green", label: "Best fit", value: `${results[0].fit}%` },
    { ramp: "gray", label: "Screened out", value: String(Object.values(rejects).reduce((a, b) => a + b, 0)) },
  ] },
];
for (const r of shown) {
  const meta = [r.location || "—", ...(r.screen?.flags || [])].filter(Boolean).join(" · ");
  blocks.push({ type: "hero", ramp: r.fit >= 80 ? "green" : r.fit >= 65 ? "amber" : "gray", kicker: `${r.fit}% FIT`, title: `${r.title} @ ${r.company}`, note: `${meta}${r.reasons ? ` · ${r.reasons}` : ""}`, buttonLabel: "Apply →", link: r.apply_url || r.url });
  blocks.push({ type: "text", html: `<b>Emphasize:</b> ${esc(r.emphasize)}${r.why_not ? `<br><b>Biggest gap:</b> ${esc(r.why_not)}` : ""}<br><br><b>Tailored cover letter</b><br>${mdToHtml(r.cover_letter)}` });
  blocks.push({ type: "divider" });
}
if (results.length > shown.length) {
  blocks.push({ type: "text", html: `<i>${results.length - shown.length} more role(s) above the bar are on the dashboard → Jobs.</i>` });
}
blocks.push({ type: "text", html: `<span style="opacity:.65">Screened out this run: ${esc(rejectLine)}.</span>` });

await notifyEmail(`💼 ${results.length} apply-ready role(s) — best ${results[0].fit}%`, renderEmail({
  title: "Apply-Ready Roles", subtitle: `${results.length} new · best fit ${results[0].fit}%`, kicker: "JOB AGENT", accent: "#0F6E56",
  blocks, footer: "Job Agent · India-eligible roles only; apply from the links; track your pipeline on the dashboard → Jobs",
}));
console.log(`Surfaced ${results.length} roles (emailed ${shown.length}).`);
