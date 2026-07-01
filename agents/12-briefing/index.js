// agents/12-briefing/index.js
import { XMLParser } from "fast-xml-parser";
import { INTERESTS, RSS_FEEDS } from "./sources.js";
import { callGemini } from "../../lib/llm.js";
import { notifyEmail } from "../../lib/notify.js";

const parser = new XMLParser();

async function readFeed(url) {
  try {
    const xml = await fetch(url).then((r) => r.text());
    const feed = parser.parse(xml);
    // Handle both RSS (channel.item) and Atom (feed.entry) shapes.
    const items = feed?.rss?.channel?.item || feed?.feed?.entry || [];
    const arr = Array.isArray(items) ? items : [items];
    return arr.slice(0, 15).map((it) => ({
      title: it.title?.["#text"] || it.title || "",
      link: it.link?.href || it.link || "",
    }));
  } catch (e) {
    console.error(`feed failed: ${url}`, e.message);
    return [];
  }
}

const all = (await Promise.all(RSS_FEEDS.map(readFeed))).flat();
if (!all.length) { console.log("No items fetched."); process.exit(0); }

const brief = await callGemini(
  `You are my personal tech curator. From these headlines, pick the 6-10 most
relevant to my interests (${INTERESTS.join(", ")}). For each: the title, a one-line
why-it-matters, and the link. Skip anything off-topic or low-signal. Group loosely
by theme.\n\nHeadlines:\n${all.map((a) => `- ${a.title} (${a.link})`).join("\n")}`
);

await notifyEmail("🗞️ Your daily tech briefing", `<pre>${brief}</pre>`);
console.log(brief);
