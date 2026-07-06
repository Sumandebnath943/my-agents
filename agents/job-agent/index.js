// agents/job-agent/index.js — Apply-Ready Job Agent.
// Gather (public ATS + remote boards) -> cheap title/location pre-filter -> dedupe against the
// jobs table -> score + tailor a cover letter with Gemini -> email a ranked, apply-ready packet.
// NO auto-submit: you click apply (compliant, and better on senior roles). The CV comes from the
// CV_TEXT secret (kept private — this repo is public); a local agents/job-agent/cv.md is a fallback.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { TITLES, LOCATIONS, MIN_FIT, GREENHOUSE, LEVER, ASHBY } from "./config.js";
import { greenhouse, lever, ashby, remoteBoards } from "./ats.js";
import { callGemini, parseJson } from "../../lib/llm.js";
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

// 2) Cheap pre-filter by title + location BEFORE spending any LLM calls.
const titleMatch = (t) => TITLES.some((x) => t.toLowerCase().includes(x.toLowerCase().split(" ").slice(-2).join(" ")) || x.toLowerCase().split(" ").every((w) => t.toLowerCase().includes(w)));
const locMatch = (l) => !l || LOCATIONS.some((x) => l.toLowerCase().includes(x));
let candidates = all.filter((j) => j.title && titleMatch(j.title) && locMatch(j.location));

// 3) Dedupe against what we've already surfaced.
const fresh = [];
for (const j of candidates) {
  const hash = createHash("sha1").update(j.url || `${j.title}@${j.company}`).digest("hex");
  const { data } = await db.from("jobs").select("id").eq("job_hash", hash).maybeSingle();
  if (!data) fresh.push({ ...j, hash });
}
if (!fresh.length) { console.log("No new matching roles."); process.exit(0); }

// 4) Score + tailor each (cap per run to stay within free limits).
const results = [];
for (const j of fresh.slice(0, 12)) {
  let scored;
  try {
    const out = await callGemini(
      `You are my job-application assistant. Given my CV and this job, return JSON:
{"fit":0-100 how well I match,"reasons":"1-2 lines","cover_letter":"a tailored 150-200 word cover letter referencing THIS company and role, in a confident, specific, non-generic voice","emphasize":"which of my CV points to foreground"}.
MY CV:\n${CV.slice(0, 6000)}\n\nJOB: ${j.title} @ ${j.company} (${j.location})\n${j.description}`,
      { json: true }
    );
    scored = parseJson(out);
  } catch { continue; }
  await db.from("jobs").insert({
    title: j.title, company: j.company, location: j.location, url: j.url,
    apply_url: j.apply_url, ats: j.ats, fit: scored.fit,
    cover_letter: scored.cover_letter, job_hash: j.hash,
  });
  if (scored.fit >= MIN_FIT) results.push({ ...j, ...scored });
}

if (!results.length) { console.log("New roles found but none above fit threshold."); process.exit(0); }

// 5) One email packet, best fit first — each with a direct apply link + cover letter.
results.sort((a, b) => b.fit - a.fit);
const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
const blocks = [
  { type: "tiles", items: [
    { ramp: "green", label: "New roles", value: String(results.length) },
    { ramp: "green", label: "Best fit", value: `${results[0].fit}%` },
  ] },
];
for (const r of results) {
  blocks.push({ type: "hero", ramp: r.fit >= 80 ? "green" : r.fit >= 65 ? "amber" : "gray", kicker: `${r.fit}% FIT`, title: `${r.title} @ ${r.company}`, note: `${r.location || "—"}${r.reasons ? ` · ${r.reasons}` : ""}`, buttonLabel: "Apply →", link: r.apply_url || r.url });
  blocks.push({ type: "text", html: `<b>Emphasize:</b> ${esc(r.emphasize)}<br><br><b>Tailored cover letter</b><br>${mdToHtml(r.cover_letter)}` });
  blocks.push({ type: "divider" });
}
await notifyEmail(`💼 ${results.length} apply-ready role(s) — best ${results[0].fit}%`, renderEmail({
  title: "Apply-Ready Roles", subtitle: `${results.length} new · best fit ${results[0].fit}%`, kicker: "JOB AGENT", accent: "#0F6E56",
  blocks, footer: "Job Agent · apply from the links; track your pipeline on the dashboard → Jobs",
}));
console.log(`Surfaced ${results.length} roles.`);
