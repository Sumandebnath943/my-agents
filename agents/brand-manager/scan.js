// agents/brand-manager/scan.js — DAILY rolling scan. Keeps a master page list in
// `brand_pages` (multi-page sites discovered via sitemap), then refreshes the
// oldest-scanned N pages: PageSpeed (cheap) always, on-page SEO audit only when the
// page CHANGED and we're under the daily LLM budget (hash-skip does the rest). This
// spreads hundreds of pages across the week without burning the free Groq/Gemini tiers.
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { PROPERTIES } from "./properties.js";
import { discoverPages } from "./discover.js";
import { extractSeo } from "./extract.js";
import { callGemini, parseJson } from "../../lib/llm.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));
const PAGES_PER_DAY = Number(process.env.BRAND_PAGES_PER_DAY || 12);
const AUDITS_PER_DAY = Number(process.env.BRAND_AUDITS_PER_DAY || 10);
const PER_SITE_CAP = Number(process.env.BRAND_PER_SITE_CAP || 100);

async function pageSpeed(url) {
  const r = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&category=performance&category=seo&category=accessibility&key=${env("PAGESPEED_KEY")}`).then((x) => x.json());
  const c = r.lighthouseResult?.categories || {}, a = r.lighthouseResult?.audits || {};
  return {
    perf: Math.round((c.performance?.score || 0) * 100), seo: Math.round((c.seo?.score || 0) * 100),
    accessibility: Math.round((c.accessibility?.score || 0) * 100),
    lcp: a["largest-contentful-paint"]?.displayValue, cls: a["cumulative-layout-shift"]?.displayValue,
    broken_links: (a["crawlable-anchors"]?.details?.items || []).length,
  };
}

// 1. Sync the master page list (partial upsert — never clobbers existing metrics/cursor).
for (const p of PROPERTIES) {
  const urls = p.crawl ? await discoverPages(p.url, PER_SITE_CAP) : [p.url];
  for (const url of urls) {
    await db.from("brand_pages").upsert({ url, property: p.name, tier: p.tier || "perf" }, { onConflict: "url" });
  }
}

// 2. Refresh the oldest-scanned N pages (never-scanned first).
const { data: due } = await db.from("brand_pages").select("*").order("last_scanned_at", { ascending: true, nullsFirst: true }).limit(PAGES_PER_DAY);

let audits = 0;
for (const page of due || []) {
  const row = { url: page.url, property: page.property, tier: page.tier, last_scanned_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  try { Object.assign(row, await pageSpeed(page.url)); } catch { row.perf = null; }
  try {
    const html = await fetch(page.url).then((r) => r.text());
    const ex = extractSeo(html);
    if (page.content_hash === ex.hash && page.seo_audit) {
      row.content_hash = ex.hash; row.seo_audit = page.seo_audit;            // unchanged — reuse, no LLM
    } else if (audits < AUDITS_PER_DAY) {
      const out = await callGemini(
        `On-page SEO audit. Return JSON {"score":0-100,"issues":[{"severity":"high|med|low","note":""}],"quick_wins":[""]}. Judge title, meta description, heading structure, alt coverage, schema, content depth. Fields:\n${JSON.stringify(ex.fields)}`,
        { json: true, model: "gemini-2.5-flash-lite" }); // own 15 RPM bucket — keeps this batch off flash's 10 RPM
      row.content_hash = ex.hash; row.seo_audit = parseJson(out); audits++;   // changed + budget available
    } else {
      row.seo_audit = page.seo_audit || null;                                 // budget spent: keep OLD hash so it re-audits next rotation
    }
  } catch {}
  await db.from("brand_pages").upsert(row, { onConflict: "url" });
}

console.log(`brand scan: ${(due || []).length} pages refreshed, ${audits} SEO audits (budget ${AUDITS_PER_DAY}).`);
