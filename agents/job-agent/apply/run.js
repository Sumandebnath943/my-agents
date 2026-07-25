// agents/job-agent/apply/run.js — the assisted-apply driver.
//
// TWO MODES, AND THE DIFFERENCE IS THE WHOLE POINT:
//   prepare  fills the application in a headless browser, screenshots it, and STOPS. Nothing is
//            sent. This is what the nightly flow and the dashboard's "Prepare" button run.
//   submit   re-fills the same form and presses submit. It REFUSES unless the role is already in
//            apply_state='prepared', which can only happen after a prepare run — meaning a human
//            has seen the filled form on the dashboard and pressed the button.
//
// There is deliberately no path that goes from "found a job" to "applied" without a person in the
// middle. A submitted application can't be recalled, and the answers include salary expectations.
//
// Usage (normally dispatched by .github/workflows/job-apply.yml):
//   node agents/job-agent/apply/run.js --id <job_id> --mode prepare|submit
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { env } from "../../../lib/env.js";
import { isUrlSafe } from "../../../lib/scrape.js";
import { callLLM } from "../../../lib/llm.js";
import { loadAnswers } from "./answers.js";
import { detectAts, ATS, planForm, summarizePlan, normalizeLabel } from "./forms.js";

// Only needed to ground essay drafts. Absent CV just means essays stay unanswered and block —
// never that something gets invented.
let CV = process.env.CV_TEXT || "";
if (!CV) { try { CV = readFileSync(new URL("../cv.md", import.meta.url), "utf8"); } catch {} }

const BUCKET = "job-agent";
const arg = (name, fallback = "") => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const jobId = arg("id", process.env.APPLY_JOB_ID || "");
const mode = arg("mode", process.env.APPLY_MODE || "prepare");
if (!jobId) { console.error("No --id given."); process.exit(1); }
if (!["prepare", "submit"].includes(mode)) { console.error(`Unknown --mode ${mode}`); process.exit(1); }

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));

// A Supabase query builder is a THENABLE, not a Promise — it has .then() but NO .catch(). Calling
// .catch() on one throws "is not a function", and having that inside the error handler is how a
// recoverable failure became an unrecoverable one: the write meant to record apply_state='failed'
// threw before it could, so the role sat on "Filling the form…" forever with the retry blocked.
// Every best-effort DB write goes through here instead. Guarded by an eval in evals/job-apply.
const quiet = async (builder) => { try { return await builder; } catch { return null; } };

const setState = (patch) => db.from("jobs").update(patch).eq("id", jobId);

const { data: job, error: jobErr } = await db.from("jobs").select("*").eq("id", jobId).maybeSingle();
if (jobErr || !job) { console.error(`Job ${jobId} not found: ${jobErr?.message || "no row"}`); process.exit(1); }

const applyUrl = job.apply_url || job.url;
const ats = detectAts(applyUrl);
if (!ats) {
  console.error(`No supported ATS for ${applyUrl} — apply by hand.`);
  await setState({ apply_state: "unsupported", apply_error: "Not a Greenhouse/Lever/Ashby form — portal applications need your logged-in session." });
  process.exit(0);
}
if (!(await isUrlSafe(applyUrl))) {
  await setState({ apply_state: "failed", apply_error: "Apply URL failed the SSRF safety check." });
  process.exit(1);
}

// THE INTERLOCK. Submitting is only ever a continuation of something a human approved.
if (mode === "submit" && job.apply_state !== "prepared") {
  console.error(`Refusing to submit: apply_state is '${job.apply_state}', not 'prepared'. A human must review the filled form first.`);
  process.exit(1);
}

const { answers, missing } = loadAnswers();
if (missing.length) console.log(`answers: ${missing.length} key(s) not configured (${missing.join(", ")}) — fields needing them will be reported unanswered.`);

// Answers you typed on the dashboard for questions the rules don't cover. Best-effort: if the
// table doesn't exist yet the run just behaves as it did before.
let learned = {};
const learnedUses = {};
try {
  const { data } = await db.from("apply_answers").select("label_norm,answer,times_used");
  for (const r of data || []) {
    if (!r.label_norm || !r.answer) continue;
    learned[r.label_norm] = r.answer;
    learnedUses[r.label_norm] = r.times_used || 0;
  }
  if (Object.keys(learned).length) console.log(`answers: ${Object.keys(learned).length} learned answer(s) available.`);
} catch (e) {
  console.error(`answers: learned-answer table unavailable (${e.message}) — run sql/apply_answers.sql.`);
}

await setState({ apply_state: mode === "submit" ? "submitting" : "preparing", apply_error: null });

const browser = await chromium.launch();
let page;
try {
  page = await browser.newPage({ viewport: { width: 1280, height: 1800 } });
  await page.goto(applyUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  // Ashby builds its form entirely in JavaScript, so waiting for the network to settle is the only
  // way its fields exist at all. Harmless for the server-rendered boards.
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // --- Discover every control and its accessible name ------------------------------------------
  const fields = await page.evaluate(() => {
    // Reading textContent off a wrapping <label> also swallows every <option> inside it — a real
    // Lever form yielded a 4000-character "label" listing every country on earth. Strip the
    // option/select/datalist text before using a container's text as a label.
    const textOf = (node) => {
      if (!node) return "";
      const clone = node.cloneNode(true);
      for (const junk of clone.querySelectorAll("option, select, datalist, script, style")) junk.remove();
      return (clone.textContent || "").replace(/\s+/g, " ").trim();
    };
    const labelFor = (el) => {
      const aria = el.getAttribute("aria-label");
      if (aria) return aria;
      const by = el.getAttribute("aria-labelledby");
      if (by) {
        const t = by.split(/\s+/).map((id) => textOf(document.getElementById(id))).join(" ").trim();
        if (t) return t;
      }
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        const t = textOf(l);
        if (t) return t;
      }
      const wrap = textOf(el.closest("label"));
      if (wrap) return wrap;
      const field = el.closest("[class*=field], [class*=application-question], .form-group, li, div");
      const heading = field?.querySelector("label, legend, .application-label, [class*=label]");
      const t = textOf(heading);
      if (t) return t;
      return el.getAttribute("placeholder") || el.getAttribute("name") || el.id || "";
    };
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      // File inputs are routinely hidden behind a styled button — they still count.
      if (el.type === "file") return true;
      return (r.width > 0 || r.height > 0) && s.visibility !== "hidden" && s.display !== "none";
    };
    const out = [];
    const radioGroups = new Map();
    for (const el of document.querySelectorAll("input, select, textarea")) {
      // Greenhouse renders an invisible `required` shim next to every react-select
      // (`aria-hidden="true" tabindex="-1"`). It is not a field, and it reported as a REQUIRED
      // question with no name at all.
      if (el.getAttribute("aria-hidden") === "true" || el.getAttribute("tabindex") === "-1") continue;
      if (el.type === "hidden" || !visible(el)) continue;
      const kind = el.type === "file" ? "file"
        : el.tagName === "SELECT" ? "select"
        : el.tagName === "TEXTAREA" ? "textarea"
        : el.getAttribute("role") === "combobox" ? "combobox"
        : el.type === "checkbox" ? "checkbox"
        : el.type === "radio" ? "radio"
        : "text";
      const label = String(labelFor(el)).replace(/\s+/g, " ").trim().slice(0, 300);
      const required = el.getAttribute("aria-required") === "true" || el.required === true;
      const selector = el.id ? `#${CSS.escape(el.id)}` : el.name ? `${el.tagName.toLowerCase()}[name="${el.name}"]` : "";

      // Radios sharing a name are ONE question. Reading each option as its own question is what
      // produced "Immediate Joiner" / "Within 30 days" / "30 - 60 Days" as separate things to
      // answer, when the real question was "Notice period" one level up.
      if (kind === "radio" && el.name) {
        if (!radioGroups.has(el.name)) {
          const legend = el.closest("fieldset")?.querySelector("legend");
          const groupBox = el.closest("[class*=field], [class*=question], .form-group, fieldset");
          const heading = groupBox?.querySelector("legend, label, [class*=label], [class*=title]");
          radioGroups.set(el.name, {
            label: textOf(legend) || textOf(heading) || label,
            kind: "radio-group", required, selector, name: el.name, id: el.id || "", options: [],
          });
        }
        radioGroups.get(el.name).options.push({ label: label || el.value, selector });
        continue;
      }
      if (!label) continue;
      out.push({ label, kind, required, selector, name: el.name || "", id: el.id || "" });
    }
    for (const [, g] of radioGroups) out.push(g);
    return out;
  });
  console.log(`Discovered ${fields.length} field(s) on the ${ats} form.`);

  // geo_class decides whether a country-neutral "authorized to work here?" is safe to answer.
  const plan = planForm(fields, answers, { geo: job.geo_class, learned });
  console.log(summarizePlan(plan));

  // A form we can barely read produces a filled-in mess plus a list of machine names to "answer".
  // Better to say so and hand it to the packet flow than to pretend.
  if (!plan.worthAutomating) {
    const why = plan.blockingUnreadable.length
      ? `${plan.blockingUnreadable.length} required field(s) can't be read by the agent`
      : `only ${plan.coverage}% of this form could be filled`;
    console.log(`Not worth automating — ${why}. Handing over to the apply-by-hand packet.`);
    await setState({
      apply_state: "unsupported",
      apply_form: { ats, apply_url: applyUrl, coverage: plan.coverage, summary: summarizePlan(plan),
        unreadable: plan.unreadable.map((f) => ({ name: f.name, id: f.id, required: !!f.required })), at: new Date().toISOString() },
      apply_error: `${why} — use the apply-by-hand packet.`,
    });
    process.exit(0);
  }

  // Essays are company-specific, so a stored answer can't be reused. The scorer already wrote a
  // grounded cover letter for THIS role; draft from that and let the owner edit before submitting.
  // Never used for pay, notice period or anything legal — isEssayQuestion() excludes those.
  for (const e of plan.essays.filter((x) => x.status === "needs_draft")) {
    try {
      const draft = await callLLM(
        `Answer this job-application question as the candidate, in first person, 80-120 words.
Ground every claim ONLY in the CV and cover letter below — invent nothing.
Plain, direct sentences. No buzzwords, no flattery, no "I am passionate about".
Return ONLY the answer text.

QUESTION: ${e.label}
ROLE: ${job.title} at ${job.company}
COVER LETTER ALREADY WRITTEN FOR THIS ROLE:\n${(job.cover_letter || "").slice(0, 1200)}
CV:\n${CV.slice(0, 2500)}`,
      );
      const text = String(draft || "").trim();
      if (text) { e.value = text; e.status = "filled"; e.drafted = true; plan.fills.push(e); }
    } catch (err) {
      console.error(`  essay draft failed for "${e.label}": ${err.message}`);
    }
  }
  // Re-derive what still blocks now that essays may have been drafted.
  plan.blocking = plan.blocking.filter((f) => !(f.key === "essay" && f.status === "filled"));
  plan.canSubmit = plan.blocking.length === 0 && plan.blockingUnreadable.length === 0;

  // Note which learned answers actually got used — cheap signal for which ones are earning their
  // keep. Best-effort: a failure here must never affect the application.
  for (const f of plan.fills.filter((x) => x.key === "learned")) {
    const norm = normalizeLabel(f.label);
    await quiet(db.from("apply_answers").update({ times_used: (learnedUses[norm] || 0) + 1 }).eq("label_norm", norm));
  }

  // --- Fill ------------------------------------------------------------------------------------
  const filled = [];
  // Dropdowns where we couldn't find an exact option and fell back to "whatever was highlighted".
  // Surfaced in the review panel, because that is precisely where a wrong country code comes from.
  const inexact = [];
  for (const f of plan.fills) {
    if (!f.selector) continue;
    try {
      const el = page.locator(f.selector).first();
      if (f.kind === "select") await el.selectOption({ label: f.value }).catch(async () => { await el.selectOption(f.value); });
      else if (f.kind === "combobox") {
        // React-select style. Taking the FIRST option after typing is wrong and was actively
        // harmful: typing "India" into a phone-country selector matched "British Indian Ocean
        // Territory" (+246) before India, and that is what got submitted. Always prefer an option
        // whose text matches EXACTLY; only fall back to the first match when there is no exact one.
        await el.click();
        await el.fill(f.value).catch(() => {});
        await page.waitForTimeout(700);
        const want = String(f.value).trim().toLowerCase();
        const options = page.locator('[role="option"], .select__option, [class*="option"]:visible');
        let picked = false;
        const n = Math.min(await options.count().catch(() => 0), 30);
        for (let i = 0; i < n; i++) {
          const text = (await options.nth(i).innerText().catch(() => "")).trim().toLowerCase();
          // "India" must beat "British Indian Ocean Territory"; a country list also renders
          // "India +91", so an exact match OR an exact first-token match both count.
          if (text === want || text.split(/[\s(+,]/)[0] === want) {
            await options.nth(i).click({ timeout: 3000 }).catch(() => {});
            picked = true;
            break;
          }
        }
        if (!picked) {
          await page.keyboard.press("Enter").catch(() => {});
          inexact.push(f.label);
        }
      } else if (f.kind === "checkbox" || f.kind === "radio") {
        if (/^(yes|true)$/i.test(f.value)) await el.check().catch(() => {});
      } else {
        await el.fill(f.value);
      }
      filled.push({ label: f.label, key: f.key });
    } catch (e) {
      console.error(`  could not fill "${f.label}": ${e.message}`);
    }
  }

  // Resume — downloaded from the private bucket to a temp file, then attached.
  let resumeAttached = false;
  const resumePath = process.env.RESUME_STORAGE_PATH || "resume/resume.pdf";
  try {
    const { data: file, error } = await db.storage.from(BUCKET).download(resumePath);
    if (error) throw error;
    const buf = Buffer.from(await file.arrayBuffer());
    await page.locator(ATS[ats].resumeInput).first().setInputFiles({
      name: resumePath.split("/").pop() || "resume.pdf",
      mimeType: "application/pdf",
      buffer: buf,
    });
    // setInputFiles resolving is not proof the widget accepted it — verify the input really holds
    // a file before claiming the resume is attached, since submit depends on this being honest.
    await page.waitForTimeout(1200);
    const count = await page.locator(ATS[ats].resumeInput).first()
      .evaluate((el) => (el.files ? el.files.length : 0)).catch(() => 0);
    resumeAttached = count > 0;
    if (!resumeAttached) console.error("  resume upload did not register on the form.");
  } catch (e) {
    console.error(`  resume not attached: ${e.message} (upload it with scripts/upload-resume.mjs)`);
  }

  // Cover letter, when the form takes it as text rather than a file.
  if (job.cover_letter) {
    try {
      const box = page.locator(ATS[ats].coverLetterInput).first();
      if (await box.count()) await box.fill(job.cover_letter);
    } catch {}
  }

  // --- Screenshot the filled form — this is what a human reviews -------------------------------
  const shot = await page.screenshot({ fullPage: true }).catch(() => null);
  let shotPath = null;
  if (shot) {
    shotPath = `applications/${jobId}/${mode}-${Date.now()}.png`;
    const { error } = await db.storage.from(BUCKET).upload(shotPath, shot, { contentType: "image/png", upsert: true });
    if (error) { console.error(`  screenshot upload failed: ${error.message}`); shotPath = null; }
  }

  const formRecord = {
    ats, apply_url: applyUrl, resume_attached: resumeAttached,
    inexact,                                   // dropdowns that may hold the wrong option
    coverage: plan.coverage,
    filled, summary: summarizePlan(plan),
    unanswered: plan.unanswered.map((f) => ({ label: f.label, required: !!f.required })),
    skipped: plan.skipped.map((f) => f.label),
    blocking: plan.blocking.map((f) => f.label),
    confidence: ATS[ats].confidence,
    at: new Date().toISOString(),
  };

  if (!plan.canSubmit) {
    console.log(`Held back — ${plan.blocking.length} required question(s) have no answer: ${plan.blocking.map((f) => f.label).join(" | ")}`);
    await setState({ apply_state: "needs_input", apply_form: formRecord, apply_shot: shotPath, apply_prepared_at: new Date().toISOString() });
    process.exit(0);
  }

  if (mode === "prepare") {
    await setState({ apply_state: "prepared", apply_form: formRecord, apply_shot: shotPath, apply_prepared_at: new Date().toISOString(), apply_attempts: (job.apply_attempts || 0) + 1 });
    console.log(`Prepared. Review it on the dashboard and press Submit — nothing has been sent.`);
    process.exit(0);
  }

  // --- Submit (only reachable in submit mode, from 'prepared') ---------------------------------
  if (!resumeAttached) {
    await setState({ apply_state: "failed", apply_form: formRecord, apply_error: "Refusing to submit without a resume attached." });
    console.error("Refusing to submit without a resume attached.");
    process.exit(1);
  }
  await page.locator(ATS[ats].submit).first().click({ timeout: 15000 });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);

  const bodyText = (await page.innerText("body").catch(() => "")).replace(/\s+/g, " ").slice(0, 1500);
  const confirmed = /thank you|application (was )?(received|submitted)|we('| ha)ve received|successfully (applied|submitted)|submitted your application/i.test(bodyText);
  const afterPath = `applications/${jobId}/submitted-${Date.now()}.png`;
  const after = await page.screenshot({ fullPage: true }).catch(() => null);
  if (after) await db.storage.from(BUCKET).upload(afterPath, after, { contentType: "image/png", upsert: true }).catch(() => {});

  const receipt = { confirmed, url: page.url(), evidence: bodyText.slice(0, 600), shot: after ? afterPath : null, at: new Date().toISOString() };
  if (confirmed) {
    await setState({ apply_state: "submitted", status: "applied", apply_receipt: receipt, apply_form: formRecord, apply_shot: afterPath });
    console.log("Submitted — confirmation captured.");
  } else {
    // The click went through but nothing on the page says it worked. Say so rather than claiming
    // success; the screenshot is the evidence for a human to judge.
    await setState({ apply_state: "failed", apply_receipt: receipt, apply_form: formRecord, apply_shot: afterPath, apply_error: "Submit clicked but no confirmation was found on the page — check the screenshot." });
    console.error("Submit clicked but no confirmation text found. Left as failed for review.");
  }
} catch (e) {
  console.error(`apply ${mode} failed: ${e.message}`);
  await quiet(setState({ apply_state: "failed", apply_error: e.message.slice(0, 400) }));
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
}
