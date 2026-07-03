// lib/reddit.js — read-only Reddit via PUBLIC no-auth JSON endpoints (no app/secret needed).
// Hardened for reliability: descriptive User-Agent, timeout, retry/backoff on 429/5xx, and a
// host fallback (www -> old). Always returns an array; never throws (callers already tolerate []).
const UA = "web:migi-agents:1.0 (personal research agent)";
const HOSTS = ["https://www.reddit.com", "https://old.reddit.com"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(path) {
  for (const host of HOSTS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), 12000);
        const res = await fetch(`${host}${path}`, {
          headers: { "User-Agent": UA, Accept: "application/json" },
          signal: ctl.signal,
        });
        clearTimeout(to);
        if (res.status === 429 || res.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
        if (!res.ok) break; // 403/404 on this host — try the next host
        return await res.json();
      } catch { await sleep(1000 * (attempt + 1)); }
    }
  }
  return null;
}

export async function subredditNew(sub, limit = 25) {
  const data = await getJson(`/r/${sub}/new.json?limit=${limit}&raw_json=1`);
  return (data?.data?.children || []).map((c) => ({
    title: c.data.title,
    text: (c.data.selftext || "").slice(0, 500),
    url: "https://reddit.com" + c.data.permalink,
  }));
}
