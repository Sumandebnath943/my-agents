// agents/12-briefing/index.js
import { INTERESTS, RSS_FEEDS } from "./sources.js";
import { callGemini, parseJson } from "../../lib/llm.js";
import { notifyEmail } from "../../lib/notify.js";
import { renderDigest } from "../../lib/email-template.js";
import { fetchXml, textOf, linkHref } from "../../lib/rss.js";

async function readFeed(url) {
  try {
    const feed = await fetchXml(url);
    // Handle both RSS (channel.item) and Atom (feed.entry) shapes.
    const items = feed?.rss?.channel?.item || feed?.feed?.entry || [];
    const arr = Array.isArray(items) ? items : [items];
    return arr.slice(0, 15).map((it) => ({
      title: textOf(it.title),
      link: linkHref(it.link),
    }));
  } catch (e) {
    console.error(`feed failed: ${url}`, e.message);
    return [];
  }
}

// Gather + de-duplicate headlines across all feeds.
const raw = (await Promise.all(RSS_FEEDS.map(readFeed))).flat().filter((a) => a.title);
const seen = new Set();
const all = raw.filter((a) => { const k = a.title.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
if (!all.length) { console.log("No items fetched."); process.exit(0); }

// Ask Gemini to curate into themed sections as JSON (so we control the design).
const out = await callGemini(
  `You are my personal tech curator. From these headlines, pick the 8-12 most relevant to my
interests (${INTERESTS.join(", ")}). Group them into 2-4 themed sections. Prefer notable
releases and genuinely important news over low-signal chatter.
Return ONLY JSON of this exact shape:
{"sections":[{"heading":"Theme name","items":[{"title":"headline","note":"one-line why it matters","link":"url"}]}]}

Headlines:
${all.map((a) => `- ${a.title} (${a.link})`).join("\n")}`,
  { json: true }
);

let sections = [];
try { sections = parseJson(out).sections || []; } catch { sections = []; }
if (!sections.length) { console.log("Curator returned nothing usable."); process.exit(0); }

const today = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });
const html = renderDigest({
  title: "🗞️ Your Daily Tech Briefing",
  subtitle: today,
  sections,
  accent: "#6C5CE7",
  footer: "Curated from Hacker News, Google News, TechCrunch, The Verge & more.",
});

await notifyEmail("🗞️ Your daily tech briefing", html);
console.log(JSON.stringify(sections, null, 2));
