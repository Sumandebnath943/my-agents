// lib/reddit.js — tiny read-only Reddit helper (shared by Build Compass + Outreach Scout).
// Uses a free "script" app's client_credentials for app-only access to public listings.
import { env } from "./env.js";

let token = null;
async function auth() {
  if (token) return token;
  const r = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${env("REDDIT_CLIENT_ID")}:${env("REDDIT_SECRET")}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  }).then((x) => x.json());
  token = r.access_token;
  return token;
}

export async function subredditNew(sub, limit = 25) {
  const t = await auth();
  const r = await fetch(`https://oauth.reddit.com/r/${sub}/new?limit=${limit}`, {
    headers: { Authorization: `Bearer ${t}`, "User-Agent": "personal-agent/1.0" },
  }).then((x) => x.json());
  return (r.data?.children || []).map((c) => ({
    title: c.data.title,
    text: (c.data.selftext || "").slice(0, 500),
    url: "https://reddit.com" + c.data.permalink,
  }));
}
