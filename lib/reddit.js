// lib/reddit.js — read subreddits via Reddit's RSS feeds (shared by Build Compass + Outreach Scout).
// Why RSS: Reddit IP-blocks the anonymous .json API from datacenters AND the OAuth path needs a
// developer app we can't create — but the RSS feeds are NOT blocked and carry the full post body in
// <content>. No app, no auth, no secret, and not nerfed (title + body + link + source subreddit).
// Reddit rate-limits RSS per-IP and dislikes "Mozilla" UAs (429), so we reuse the repo's fetchXml
// (default UA), throttle, and retry — and prefer the MULTI-subreddit feed (/r/a+b+c/new/.rss) so a
// whole radar is ONE request instead of many (the reliable way to dodge the rate limit).
import { fetchXml, textOf, linkHref } from "./rss.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripHtml = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
const subOf = (e) => { const t = e.category?.["@_term"] || e.category?.["@_label"] || ""; return t ? `r/${t}` : "reddit"; };

// Space Reddit calls >= 1.5s apart regardless of caller, to avoid 429s.
let lastAt = 0;
async function throttle() {
  const wait = 1500 - (Date.now() - lastAt);
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
}

async function fetchListing(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await throttle();
    try {
      const feed = await fetchXml(url);
      const entries = feed?.feed?.entry;
      if (entries === undefined) { await sleep(2500 * (attempt + 1)); continue; } // 429/HTML -> retry
      const arr = Array.isArray(entries) ? entries : [entries];
      const out = arr
        .map((e) => ({ title: textOf(e.title), text: stripHtml(textOf(e.content)).slice(0, 500), url: linkHref(e.link), source: subOf(e) }))
        .filter((a) => a.title);
      if (out.length) return out;
      await sleep(1500 * (attempt + 1));
    } catch { await sleep(1500 * (attempt + 1)); }
  }
  return [];
}

// One subreddit.
export async function subredditNew(sub, limit = 25) {
  return fetchListing(`https://www.reddit.com/r/${sub}/new/.rss?limit=${limit}`);
}
// Many subreddits in ONE request — /r/a+b+c/new/.rss. Preferred for radars.
export async function subredditsNew(subs, limit = 60) {
  const path = Array.isArray(subs) ? subs.join("+") : subs;
  return fetchListing(`https://www.reddit.com/r/${path}/new/.rss?limit=${limit}`);
}
