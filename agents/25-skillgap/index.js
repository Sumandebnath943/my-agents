// agents/25-skillgap/index.js — Skill-Gap Advisor (#25).
// Monthly. Looks at what you've actually been building (last 60 days of GitHub activity) vs. what's
// rising in your field (Groq `groq/compound` = web-search-enabled) and names AT MOST TWO specific
// skills to learn next — deliberately narrow, to fight overwhelm rather than feed it.
import { env } from "../../lib/env.js";
import { OWNER, FOCUS } from "./config.js";
import { callGroq } from "../../lib/llm.js";
import { notifyEmail } from "../../lib/notify.js";

// What have you actually been building? (last 60 days of public repo activity)
const since = new Date(Date.now() - 60 * 86400000);
let repos = [];
try {
  const events = await fetch(`https://api.github.com/users/${OWNER}/events/public?per_page=100`, {
    headers: { Authorization: `Bearer ${env("GH_PAT")}`, Accept: "application/vnd.github+json", "User-Agent": "migi-agents" },
  }).then((r) => r.json());
  repos = [...new Set((Array.isArray(events) ? events : [])
    .filter((e) => new Date(e.created_at) > since)
    .map((e) => e.repo?.name))].filter(Boolean).slice(0, 20);
} catch {}

const system = "You are a sharp, realistic mentor. Recommend AT MOST TWO specific, learnable skills — not a laundry list. Each: why it matters now, how it builds on what they already do, and a first concrete step. Exactly one or two — never more. Fight overwhelm; be selective and concrete.";
const user = `My focus: ${FOCUS}\nRecent repos I worked on: ${repos.join(", ") || "(none detected this period)"}\nSearch for what's currently in demand / rising in this space, then pick my best next 1-2 skills.`;

// Prefer web-search-enabled compound; fall back to the default model if it's unavailable.
let advice;
try {
  advice = await callGroq([{ role: "system", content: system }, { role: "user", content: user }], { model: "groq/compound" });
} catch {
  advice = await callGroq([{ role: "system", content: system }, { role: "user", content: user }]);
}

await notifyEmail(
  "🎯 Your next skill(s) to learn",
  `<pre style="white-space:pre-wrap;font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">${String(advice).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`
);
console.log(advice);
