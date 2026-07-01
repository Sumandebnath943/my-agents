// agents/18-video-digest/index.js
// Evening digest: newest uploads (last 24h) from your channels + curated AI voices.
// One line each with a link, grouped, emailed. No LLM needed.
import { CHANNELS, AI_KEYWORDS } from "./channels.js";
import { getState, setState } from "../../lib/store.js";
import { fetchXml, textOf, linkHref } from "../../lib/rss.js";
import { notifyEmail } from "../../lib/notify.js";
import { renderEmail } from "../../lib/email-template.js";

const WINDOW_MS = 24 * 3600 * 1000;                     // "new" = uploaded in the last 24h
const AI_RE = new RegExp(`\\b(${AI_KEYWORDS.join("|")})\\b`, "i");

function idFromUrl(input) {
  const m = input.match(/UC[\w-]{20,}/);               // /channel/UC... or a bare id
  return m && !input.includes("@") ? m[0] : null;
}

// Resolve an @handle (or channel URL) to a channel_id, caching the result in kv.
async function resolveChannelId(input) {
  const direct = idFromUrl(input);
  if (direct) return direct;
  const key = `yt:cid:${input}`;
  const cached = await getState(key, null);
  if (cached) return cached;
  try {
    const url = input.startsWith("http")
      ? input
      : `https://www.youtube.com/${input.startsWith("@") ? input : "@" + input}`;
    const html = await fetch(url, { headers: { "accept-language": "en" } }).then((r) => r.text());
    const id = (html.match(/"channelId":"(UC[\w-]+)"/) ||
                html.match(/channel\/(UC[\w-]+)/) || [])[1];
    if (id) { await setState(key, id); return id; }
    console.error("no channelId found for", input);
  } catch (e) {
    console.error("resolve failed", input, e.message);
  }
  return null;
}

async function latestFrom(ch) {
  const id = await resolveChannelId(ch.url);
  if (!id) return [];
  try {
    const feed = await fetchXml(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`);
    const channel = textOf(feed?.feed?.title) || ch.url;
    const entries = feed?.feed?.entry
      ? (Array.isArray(feed.feed.entry) ? feed.feed.entry : [feed.feed.entry])
      : [];
    const now = Date.now();
    let vids = entries
      .map((e) => ({
        channel,
        title: textOf(e.title),
        link: linkHref(e.link),
        published: new Date(e.published).getTime(),
      }))
      .filter((v) => v.published && now - v.published <= WINDOW_MS);
    if (ch.aiOnly) vids = vids.filter((v) => AI_RE.test(v.title));
    return vids;
  } catch (e) {
    console.error("feed failed", id, e.message);
    return [];
  }
}

const videos = (await Promise.all(CHANNELS.map(latestFrom))).flat();
videos.sort((a, b) => b.published - a.published);

if (!videos.length) { console.log("No new videos in the last 24h."); process.exit(0); }

const rel = (t) => { const h = Math.round((Date.now() - t) / 3600000); return h <= 1 ? "just now" : `${h}h ago`; };
const blocks = [{
  type: "listSection",
  ramp: "red",
  heading: `🎬 ${videos.length} NEW VIDEO${videos.length > 1 ? "S" : ""}`,
  items: videos.map((v) => ({
    title: `${v.channel} — ${v.title}`,
    note: rel(v.published),
    link: v.link,
    buttonLabel: "▶ Watch",
  })),
}];

const today = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });
const html = renderEmail({
  title: "🎬 Evening Video Digest",
  kicker: `EVENING EDITION · ${today}`,
  accent: "#C0392B",
  blocks,
  footer: "Newest uploads from your channels + curated AI voices.",
});
await notifyEmail("🎬 Your evening video digest", html);
console.log(videos.map((v) => `${v.channel}: ${v.title}`).join("\n"));
