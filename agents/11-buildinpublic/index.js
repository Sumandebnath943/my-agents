// agents/11-buildinpublic/index.js
// Draft-only: turn the day's git activity into a short build-in-public post → email.
import { env } from "../../lib/env.js";
import { callGroq } from "../../lib/llm.js";
import { notifyEmail } from "../../lib/notify.js";
import { renderEmail } from "../../lib/email-template.js";
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

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const html = renderEmail({
  title: "🛠️ Build-in-Public Draft",
  kicker: "SHIPPED TODAY",
  accent: "#0F6E56",
  blocks: [{ type: "text", html: esc(post).replace(/\n/g, "<br>") }],
  footer: "Drop it on X / LinkedIn when ready",
});
await notifyEmail("🛠️ Your build-in-public draft", html);
console.log(post);
