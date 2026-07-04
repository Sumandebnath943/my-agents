// agents/brand-manager/discover.js — find a site's pages via its sitemap (handles a
// sitemap index that points to child sitemaps). Returns a capped, deduped URL list.
// Falls back to just the site URL when no sitemap is reachable.
import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({ ignoreAttributes: false });

async function fetchXml(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "migi-brand" } });
    if (!r.ok) return null;
    return parser.parse(await r.text());
  } catch { return null; }
}

function collect(x, set) {
  const u = x?.urlset?.url;
  if (!u) return;
  for (const it of Array.isArray(u) ? u : [u]) if (it.loc) set.add(String(it.loc).trim());
}

export async function discoverPages(siteUrl, cap = 40) {
  const origin = new URL(siteUrl).origin;
  const roots = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/sitemap-index.xml`];
  const set = new Set();

  for (const root of roots) {
    const x = await fetchXml(root);
    if (!x) continue;
    const idx = x.sitemapindex?.sitemap;
    if (idx) {
      for (const m of (Array.isArray(idx) ? idx : [idx]).slice(0, 15)) {
        if (m.loc) collect(await fetchXml(String(m.loc).trim()), set);
        if (set.size >= cap) break;
      }
    } else {
      collect(x, set);
    }
    if (set.size) break; // first working sitemap wins
  }
  if (!set.size) set.add(siteUrl);
  return [...set].slice(0, cap);
}
