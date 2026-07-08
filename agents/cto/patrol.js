// agents/cto/patrol.js — central "CTO" that reviews NEW commits across ALL your owned
// repos (existing + new, auto-discovered), tracks a per-repo cursor in Supabase, and
// delivers ONE consolidated PDF report to Telegram. Runs daily (+ /cto on demand).
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { OWNER, IGNORE } from "../04-standup/repos.js";
import { callLLM, parseJson } from "../../lib/llm.js";
import { notifyTelegram, notifyTelegramDocument, tgEscape } from "../../lib/notify.js";
import { getState, setState } from "../../lib/store.js";
import { renderCtoPdf } from "./pdf.js";

const MAX_REPOS = Number(process.env.CTO_MAX_REPOS || 25);   // safety cap on repos reviewed per run
const DIFF_CAP = 15000;                                       // chars of diff sent to the LLM per repo
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));

const gh = (path) =>
  fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${env("GH_PAT")}`, Accept: "application/vnd.github+json", "User-Agent": "migi-cto" },
  }).then((r) => (r.ok ? r.json() : null));

async function ownedRepos() {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await gh(`/user/repos?affiliation=owner&per_page=100&page=${page}&sort=pushed&direction=desc`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

// Build a capped, readable diff string from the compare API's file patches.
function diffFrom(files) {
  let out = "";
  for (const f of files || []) {
    if (!f.patch) continue;                       // binary / no textual patch
    if (/package-lock\.json|pnpm-lock|yarn\.lock/.test(f.filename)) continue;
    const block = `\n=== ${f.filename} (${f.status}) ===\n${f.patch}\n`;
    if (out.length + block.length > DIFF_CAP) { out += `\n… (diff truncated at ${DIFF_CAP} chars)`; break; }
    out += block;
  }
  return out;
}

async function reviewRepo(repo, diff, commitSubjects) {
  const review = await callLLM([
    { role: "system", content: `You are a senior staff engineer reviewing new commits in the repo "${repo}". Return JSON:
{"verdict":"approve|comment|request_changes","summary":"1-2 lines on what changed and its quality","issues":[{"severity":"high|med|low","category":"security|performance|quality|duplication|docs|tests","note":"specific+actionable","where":"file/line hint"}]}.
Flag real problems only: leaked secrets, injection, obvious perf issues, duplicated logic, missing error handling, undocumented public functions, code changed with no matching test. Skip nitpicks.` },
    { role: "user", content: `Recent commit subjects:\n${commitSubjects.join("\n")}\n\nDiff:\n${diff}` },
  ], { json: true });
  return parseJson(review);
}

// ---- run --------------------------------------------------------------------
const repos = (await ownedRepos()).filter((r) => !r.archived && !IGNORE.includes(r.name));
const reviewed = [];
let newlyWatched = 0;

for (const r of repos) {
  const name = r.name;
  const branch = r.default_branch || "main";
  const head = (await gh(`/repos/${OWNER}/${name}/commits/${encodeURIComponent(branch)}`))?.sha;
  if (!head) continue;

  const cursor = await getState(`cto:last:${name}`, null);
  if (!cursor) { await setState(`cto:last:${name}`, head); newlyWatched++; continue; } // seed, don't review history
  if (cursor === head) continue;                                                        // nothing new

  const cmp = await gh(`/repos/${OWNER}/${name}/compare/${cursor}...${head}`);
  await setState(`cto:last:${name}`, head);                                             // advance cursor regardless
  if (!cmp || !(cmp.commits?.length)) continue;                                          // force-push / no textual change

  const diff = diffFrom(cmp.files);
  if (!diff.trim()) continue;
  const subjects = cmp.commits.map((c) => c.commit.message.split("\n")[0]).slice(0, 20);

  try {
    const rv = await reviewRepo(name, diff, subjects);
    reviewed.push({ repo: name, commits: cmp.commits.length, verdict: rv.verdict || "comment", summary: rv.summary || "", issues: rv.issues || [], url: cmp.html_url });
    await db.from("code_reviews").insert({ repo: name, sha: head, verdict: rv.verdict || "comment", issues: rv.issues || [] });
  } catch (e) {
    reviewed.push({ repo: name, commits: cmp.commits.length, verdict: "comment", summary: `Review failed: ${e.message}`, issues: [], url: cmp.html_url });
  }
  if (reviewed.length >= MAX_REPOS) break;
}

// Nothing to report? Send a quiet all-clear (skip on the very first seeding run).
if (!reviewed.length) {
  const msg = newlyWatched
    ? `🤖 <b>CTO patrol</b>\nNow watching ${newlyWatched} repo(s). Reviews start on your next commits.`
    : `🤖 <b>CTO patrol</b>\nNo new commits across your repos since the last run. All quiet ✅`;
  await notifyTelegram(msg, { html: true });
  console.log(msg);
  process.exit(0);
}

const totals = {
  repos: reviewed.length,
  commits: reviewed.reduce((s, r) => s + (r.commits || 0), 0),
  issues: reviewed.reduce((s, r) => s + (r.issues?.length || 0), 0),
};
const sevCount = { high: 0, med: 0, low: 0 };
for (const r of reviewed) for (const i of r.issues || []) if (sevCount[i.severity] != null) sevCount[i.severity]++;

const date = new Date().toISOString().slice(0, 10);
const pdf = await renderCtoPdf({ date, totals, repos: reviewed });

const flagged = reviewed.filter((r) => r.verdict === "request_changes");
const caption =
  `🤖 <b>CTO review — ${date}</b>\n` +
  `${totals.repos} repo(s) · ${totals.commits} commit(s) · ${totals.issues} issue(s) ` +
  `(<b>${sevCount.high}</b> high · ${sevCount.med} med · ${sevCount.low} low)` +
  (flagged.length ? `\n⚠️ Needs changes: ${tgEscape(flagged.map((r) => r.repo).join(", "))}` : "");

await notifyTelegramDocument(pdf, `cto-review-${date}.pdf`, caption);
console.log(caption.replace(/<[^>]+>/g, ""));
