// agents/04-standup/index.js
import { env } from "../../lib/env.js";
import { OWNER, IGNORE } from "./repos.js";
import { callGroq } from "../../lib/llm.js";
import { notifyTelegram, tgEscape } from "../../lib/notify.js";
import { getState, setState } from "../../lib/store.js";

const gh = (path) =>
  fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${env("GH_PAT")}`, Accept: "application/vnd.github+json" },
  }).then((r) => r.json());

// 1. Discover all repos you own that the token can see (auto-includes new ones).
async function ownedRepos() {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await gh(`/user/repos?affiliation=owner&per_page=100&page=${page}&sort=created&direction=desc`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

const repos = await ownedRepos();
const repoNames = repos
  .filter((r) => !r.archived)        // skip archived repos
  .map((r) => r.name)
  .filter((n) => !IGNORE.includes(n));

// 2. Detect newly created repos vs the last run (remembered in Supabase kv).
const known = (await getState("standup:known_repos", [])) || [];
const firstRun = known.length === 0;
const newRepos = firstRun ? [] : repoNames.filter((n) => !known.includes(n));
if (repoNames.length) await setState("standup:known_repos", repoNames);

// 3. Pull recent activity per repo (last 36h commits + open issues/PRs).
const since = new Date(Date.now() - 36 * 3600 * 1000).toISOString();

const perRepo = [];
for (const repo of repoNames) {
  const [commits, issues] = await Promise.all([
    gh(`/repos/${OWNER}/${repo}/commits?since=${since}&per_page=10`),
    gh(`/repos/${OWNER}/${repo}/issues?state=open&per_page=10`), // issues API also returns PRs
  ]);
  const commitMsgs = (Array.isArray(commits) ? commits : []).map((c) => c.commit.message.split("\n")[0]);
  const openItems = (Array.isArray(issues) ? issues : []).map(
    (i) => `${i.pull_request ? "PR" : "Issue"} #${i.number}: ${i.title}`
  );
  // Only include repos that actually have something to report.
  if (commitMsgs.length || openItems.length) {
    perRepo.push({ repo, commits: commitMsgs, openItems });
  }
}

const raw =
  perRepo
    .map((r) => `## ${r.repo}\nRecent commits:\n${r.commits.join("\n") || "(none)"}\nOpen:\n${r.openItems.join("\n") || "(none)"}`)
    .join("\n\n") || "(no repo activity in the last 36h)";

const brief = await callGroq([
  { role: "system", content: "You are a focused dev coach. Given activity across repos, write a short 'where you left off' brief: for each repo one line on the apparent current state, then suggest the single highest-leverage next action overall. Keep it tight." },
  { role: "user", content: raw },
]);

let msg = `☀️ <b>Morning standup</b>\n\n${tgEscape(brief)}`;
if (newRepos.length) {
  msg += `\n\n🆕 <b>New repo(s) since last standup:</b> ${tgEscape(newRepos.join(", "))}`;
}

await notifyTelegram(msg, { html: true });
console.log(msg);
