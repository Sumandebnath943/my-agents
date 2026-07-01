// agents/10-linkedin/10a-draft.js
// Draft-only: generate a LinkedIn thought-leadership post in your voice, anchored in
// this week's real work, send it to Telegram for approval, and save it to a queue.
// (No auto-posting — you copy-paste to LinkedIn when you like it.)
import { env } from "../../lib/env.js";
import { callGemini } from "../../lib/llm.js";
import { notifyTelegram, tgEscape } from "../../lib/notify.js";
import { getState, setState } from "../../lib/store.js";
import { PROFILE, profileContext } from "../../lib/profile.js";

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

let activity = "";
for (const r of await ownedRepos()) {
  const commits = await gh(`/repos/${OWNER}/${r.name}/commits?since=${since}&per_page=10`);
  const msgs = (Array.isArray(commits) ? commits : []).map((c) => c.commit.message.split("\n")[0]);
  if (msgs.length) activity += `\n${r.name}: ${msgs.join("; ")}`;
}

const prompt = `You are a ghostwriter positioning me as an ${PROFILE.positioning}.
${profileContext()}

Write ONE LinkedIn post (120-200 words) that teaches something real and reinforces my positioning.
Anchor it in this week's actual work if relevant; otherwise pick a content pillar and share a concrete principle.
No hashtag spam, minimal emoji, no buzzwords. Return ONLY the post text.

This week's work:${activity || " (nothing notable — pick a pillar and share a principle)"}`;

const draft = await callGemini(prompt); // not sensitive → Gemini is fine

const queue = (await getState("linkedin:queue", [])) || [];
const id = Date.now();
queue.push({ id, text: draft, status: "pending", created_at: new Date().toISOString() });
await setState("linkedin:queue", queue);

await notifyTelegram(
  `📝 <b>LinkedIn draft</b> <i>(id ${id})</i>\n\n${tgEscape(draft)}\n\n<i>Copy-paste to LinkedIn when you like it · see all with /drafts</i>`,
  { html: true }
);
console.log(draft);
