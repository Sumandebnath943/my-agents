// lib/scrape.js — get clean, LLM-ready text for a URL.
// Firecrawl returns tidy markdown even for JS-heavy / anti-bot / paywalled-preview pages. When it's
// absent, over its free ceiling, or erroring, we fall straight back to the plain fetch+strip every
// agent used before — scraping never breaks, it just gets better when Firecrawl is available.
import { lookup } from "node:dns/promises";
import { withCeiling } from "./tier.js";

// --- SSRF guard ---------------------------------------------------------------------------------
// Only http(s), and never a target that resolves to a private/loopback/link-local address (blocks
// cloud-metadata theft + internal probing when a URL comes from a feed/scraped page/user link).
const isPrivateIp = (ip) =>
  /^(127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0$|::1$|fe80:|fc00:|fd)/i.test(ip) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

export async function isUrlSafe(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (isPrivateIp(host)) return false;                 // literal private IP
  try {                                                 // resolve hostnames (catch DNS → private)
    const addrs = await lookup(host, { all: true });
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) return false;
  } catch { return false; }                             // unresolvable → treat as unsafe
  return true;
}

// Baseline: the fetch + tag-strip approach used across the fleet (kept byte-for-byte compatible).
export async function plainFetch(url, max = 8000) {
  try {
    if (!(await isUrlSafe(url))) return "";
    const html = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.text());
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, max);
  } catch { return ""; }
}

async function firecrawlScrape(url, max) {
  const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
  });
  if (!res.ok) throw new Error(`firecrawl ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const md = (await res.json())?.data?.markdown || "";
  if (!md) throw new Error("firecrawl: empty markdown");
  return md.slice(0, max);
}

/** Clean text for a URL — Firecrawl when available (ceiling-guarded), else plain fetch+strip. */
export async function scrapeClean(url, { max = 8000 } = {}) {
  if (!(await isUrlSafe(url))) return "";                 // guard the Firecrawl path too
  if (!process.env.FIRECRAWL_API_KEY) return plainFetch(url, max);
  const { result } = await withCeiling("firecrawl", () => firecrawlScrape(url, max), () => plainFetch(url, max));
  return result;
}
