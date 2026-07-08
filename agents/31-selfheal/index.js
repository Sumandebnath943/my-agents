// agents/31-selfheal/index.js
// Failure Triage — scans recent FAILED GitHub Actions runs, uses an LLM to diagnose the likely
// cause + file + one-step fix, and sends a Telegram alert. SUGGESTS ONLY — it never edits code and
// never re-dispatches a run (human-in-the-loop, matching the fleet's draft-first philosophy).
// Dedupes via kv so each failure is reported exactly once. Skips its OWN failures (no loops).
import { env } from "../../lib/env.js";
import { getState, setState } from "../../lib/store.js";
import { callLLM, parseJson } from "../../lib/llm.js";
import { notifyTelegram, tgEscape } from "../../lib/notify.js";

const REPO = process.env.GITHUB_REPOSITORY || "Sumandebnath943/my-agents";
const SELF = "Failure Triage";              // this workflow's `name:` — never triage ourselves
const SEEN_KEY = "selfheal:seen_run_ids";
const LOOKBACK_MS = 24 * 3600 * 1000;
const MAX_PER_RUN = 5;                       // cap alerts (and LLM calls) per invocation

const gh = (path) =>
  fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${env("GH_PAT")}`, Accept: "application/vnd.github+json", "User-Agent": "migi-selfheal" },
  });

const seen = new Set((await getState(SEEN_KEY, [])) || []);
const cutoff = new Date(Date.now() - LOOKBACK_MS);

// 1) Recent failed runs (most recent first).
let runs = [];
try {
  const res = await gh(`/repos/${REPO}/actions/runs?status=failure&per_page=30`);
  runs = (await res.json()).workflow_runs || [];
} catch (e) { console.error("Could not list runs:", e.message); process.exit(0); }

const fresh = runs.filter((r) => !seen.has(r.id) && r.name !== SELF && new Date(r.created_at) >= cutoff);
if (!fresh.length) { console.log("No new failures to triage."); process.exit(0); }

let alerted = 0;
for (const run of fresh.slice(0, MAX_PER_RUN)) {
  seen.add(run.id);

  // 2) Find the failed job + step, and pull the tail of its log (errors cluster at the end).
  let failedJob = null, log = "";
  try {
    const jobs = (await (await gh(`/repos/${REPO}/actions/runs/${run.id}/jobs`)).json()).jobs || [];
    failedJob = jobs.find((j) => j.conclusion === "failure") || jobs[0] || null;
    if (failedJob) {
      const lr = await gh(`/repos/${REPO}/actions/jobs/${failedJob.id}/logs`); // redirects to plain-text log
      if (lr.ok) log = (await lr.text()).slice(-4000);
    }
  } catch (e) { console.error(`run ${run.id}: log fetch failed:`, e.message); }
  const failedStep = failedJob?.steps?.find((s) => s.conclusion === "failure")?.name || "unknown step";

  // 3) LLM diagnosis (best-effort — a bad/absent diagnosis still sends a useful alert).
  let diag = { cause: "", file: "", fix: "" };
  try {
    const out = await callLLM(
      [
        { role: "system", content: "You are a CI failure triager for a Node.js (ESM) agent fleet on GitHub Actions. Reply ONLY with JSON." },
        { role: "user", content: `A workflow run failed.\nWorkflow: ${run.name}\nFailed step: ${failedStep}\n\nLog tail:\n${log || "(no log available)"}\n\nReturn {"cause":"one-line root cause","file":"the single most likely file to fix, or ''","fix":"a concrete one-step fix suggestion"}.` },
      ],
      { json: true }
    );
    diag = { ...diag, ...parseJson(out) };
  } catch (e) { console.error(`run ${run.id}: diagnosis failed:`, e.message); }

  // 4) Alert (suggestion only — no code change, no re-run).
  const msg =
    `🛠️ <b>Agent failure</b> — ${tgEscape(run.name)}\n` +
    `<i>step: ${tgEscape(failedStep)}</i>\n\n` +
    `<b>Likely cause:</b> ${tgEscape(diag.cause || "unknown (see log)")}\n` +
    (diag.file ? `<b>File:</b> <code>${tgEscape(diag.file)}</code>\n` : "") +
    `<b>Suggested fix:</b> ${tgEscape(diag.fix || "inspect the run log")}\n\n` +
    `<a href="${run.html_url}">View run →</a>`;
  try { await notifyTelegram(msg, { html: true }); alerted++; }
  catch (e) { console.error(`run ${run.id}: alert failed:`, e.message); }
}

// 5) Persist the bounded seen-list so we don't re-alert.
await setState(SEEN_KEY, [...seen].slice(-200));
console.log(`Triaged ${alerted} of ${fresh.length} new failure(s).`);
