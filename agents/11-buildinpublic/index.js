// agents/11-buildinpublic/index.js
// Draft-only: turn the day's git activity into a short build-in-public post → Telegram.
import { env } from "../../lib/env.js";
import { callGroq } from "../../lib/llm.js";
import { notifyTelegram, tgEscape } from "../../lib/notify.js";
import { PROFILE } from "../../lib/profile.js";

const OWNER = "Sumandebnath943";
const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const gh = (p) =>
  fetch(`https://api.github.com${p}`, {
    headers: { Authorization: `Bearer ${env("GH_PAT")}`, Accept: "application/vnd.github+json" },
  }).then((r) => r.json());

async function ownedRepos() {
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const b = await gh(`/user/repos?affiliation=owner&per_page=100&page=${page}&sort=pushed`);
    if (!Array.isArray(b) || !b.length) break;
    out.push(...b);
    if (b.length < 100) break;
  }
  return out;
}

let work = "";
for (const r of await ownedRepos()) {
  const commits = await gh(`/repos/${OWNER}/${r.name}/commits?since=${since}&per_page=10`);
  const msgs = (Array.isArray(commits) ? commits : []).map((c) => c.commit.message.split("\n")[0]);
  if (msgs.length) work += `\n${r.name}: ${msgs.join("; ")}`;
}

if (!work) { console.log("No commits today — nothing to post."); process.exit(0); }

const post = await callGroq([
  { role: "system", content: `Write a single short build-in-public post (under 280 chars), first person, upbeat but not cringe, at most 1 emoji, no hashtags. Voice: ${PROFILE.voice}` },
  { role: "user", content: `Today I worked on:${work}` },
]);

await notifyTelegram(`🛠️ <b>Build-in-public draft</b>\n\n${tgEscape(post)}`, { html: true });
console.log(post);
