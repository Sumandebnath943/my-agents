// agents/48-launch/index.js — Micro-Launch Autopilot (#48), drafting step.
// Usage: node agents/48-launch/index.js <owner> <repo>   (or env LAUNCH_OWNER/LAUNCH_REPO)
// Reads a shipped repo's meta + README and drafts platform-tailored launch posts with Gemini, then
// Telegrams them with a one-tap "Post the Bluesky one" button (auto-postable, free). Show HN /
// Reddit / X / Product Hunt stay copy-only — you submit those yourself (each has its own etiquette).
import { env } from "../../lib/env.js";
import { callGemini, parseJson } from "../../lib/llm.js";
import { notifyTelegram, tgEscape } from "../../lib/notify.js";
import { setState } from "../../lib/store.js";

const owner = process.argv[2] || process.env.LAUNCH_OWNER;
const repo = process.argv[3] || process.env.LAUNCH_REPO;
if (!owner || !repo) { console.error("usage: node index.js <owner> <repo>"); process.exit(1); }

const meta = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
  headers: { Authorization: `Bearer ${env("GH_PAT")}`, Accept: "application/vnd.github+json", "User-Agent": "migi-agents" },
}).then((r) => r.json());
if (!meta || meta.message) { await notifyTelegram(`🔴 Launch: couldn't read ${tgEscape(`${owner}/${repo}`)} (${tgEscape(meta?.message || "error")}).`, { html: true }); process.exit(1); }

const readme = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${meta.default_branch || "main"}/README.md`)
  .then((r) => (r.ok ? r.text() : "")).catch(() => "");

const drafts = await callGemini(
  `I'm launching this project. Write tailored launch posts in a confident, specific, non-cringe voice. Return ONLY JSON:
{"show_hn":"Show HN title + 2-line body","reddit":"a r/SideProject-style post","bluesky":"<=290 chars, punchy, at most 1 emoji, no hashtag spam","x":"<=270 chars","producthunt_tagline":"<=60 chars"}.
Project: ${meta.name} — ${meta.description || ""}
URL: ${meta.homepage || meta.html_url}
README:
${readme.slice(0, 3000)}`,
  { json: true }
);
let d = {};
try { d = parseJson(drafts); } catch {}
if (!d.bluesky) { await notifyTelegram("🔴 Launch: couldn't draft posts. Try again.", { html: true }); process.exit(1); }

await setState("launch:pending", { repo: `${owner}/${repo}`, name: meta.name, bluesky: d.bluesky, url: meta.homepage || meta.html_url });

const buttons = [[{ text: "🚀 Post the Bluesky one", callback_data: "launch:bsky" }, { text: "✖ Dismiss", callback_data: "launch:skip" }]];
await notifyTelegram(
  `🚀 <b>Launch drafts — ${tgEscape(meta.name)}</b>\n\n<b>Bluesky</b> <i>(tap below to auto-post)</i>:\n${tgEscape(d.bluesky)}\n\n<b>Show HN:</b>\n${tgEscape(d.show_hn || "")}\n\n<b>Reddit (r/SideProject):</b>\n${tgEscape(d.reddit || "")}\n\n<b>X</b> <i>(copy only — paid API)</i>:\n${tgEscape(d.x || "")}\n\n<b>PH tagline:</b> ${tgEscape(d.producthunt_tagline || "")}`,
  { html: true, buttons }
);
console.log("Launch drafts sent for", meta.name);
