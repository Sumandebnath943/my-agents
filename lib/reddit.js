// lib/reddit.js — authenticated Reddit reader (shared by Build Compass + Outreach Scout).
// Reddit IP-blocks ANONYMOUS datacenter traffic, but the authenticated OAuth API
// (oauth.reddit.com) is the sanctioned server path and works from GitHub Actions. So we use
// client_credentials from a free "script" app. If creds aren't set, we no-op (return []) — no
// wasted anonymous requests — so every caller degrades gracefully until Reddit is configured.
const UA = "web:migi-agents:1.0 (personal research agent)";
const configured = () => !!(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_SECRET);

let token = null, exp = 0;
async function auth() {
  if (token && Date.now() < exp) return token;
  try {
    const r = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_SECRET}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UA,
      },
      body: "grant_type=client_credentials",
    }).then((x) => x.json());
    token = r.access_token || null;
    exp = Date.now() + (((r.expires_in || 3600) - 60) * 1000);
  } catch { token = null; }
  return token;
}

export async function subredditNew(sub, limit = 25) {
  if (!configured()) return []; // Reddit not set up yet — skip cleanly
  try {
    const t = await auth();
    if (!t) return [];
    const r = await fetch(`https://oauth.reddit.com/r/${sub}/new?limit=${limit}`, {
      headers: { Authorization: `Bearer ${t}`, "User-Agent": UA },
    }).then((x) => x.json());
    return (r.data?.children || []).map((c) => ({
      title: c.data.title,
      text: (c.data.selftext || "").slice(0, 500),
      url: "https://reddit.com" + c.data.permalink,
    }));
  } catch { return []; }
}

export { configured as redditConfigured };
