// agents/brand-manager/index.js
// Weekly two-tier brand report. Every metric is computed deterministically; the LLM only
// (a) audits on-page SEO per page (trimmed input, hash-skipped when unchanged) and
// (b) writes the final narrative. It never invents a number.
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { PROPERTIES } from "./properties.js";
import { extractSeo } from "./extract.js";
import { googleToken } from "../../lib/google-auth.js";
import { callGemini, parseJson } from "../../lib/llm.js";
import { notifyEmail } from "../../lib/notify.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));
const week = new Date().toISOString().slice(0, 10);

// --- data sources -----------------------------------------------------------
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
async function gsc(p, token) {
  const end = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
  const start = new Date(Date.now() - 9 * 864e5).toISOString().slice(0, 10);
  const body = { startDate: start, endDate: end, dimensions: ["query"], rowLimit: 10,
    ...(p.gscFilter ? { dimensionFilterGroups: [{ filters: [{ dimension: "page", operator: "contains", expression: p.gscFilter }] }] } : {}) };
  const r = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(p.gscSite)}/searchAnalytics/query`,
    { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json());
  const rows = r.rows || [];
  return { clicks: rows.reduce((s, x) => s + x.clicks, 0), impressions: rows.reduce((s, x) => s + x.impressions, 0),
    avg_position: rows.length ? Math.round(rows.reduce((s, x) => s + x.position, 0) / rows.length * 10) / 10 : null,
    top: rows.slice(0, 5).map((x) => ({ q: x.keys[0], pos: Math.round(x.position * 10) / 10, clicks: x.clicks })) };
}
async function ga4(p, token) {
  const filter = p.gscFilter ? { dimensionFilter: { filter: { fieldName: "pagePath", stringFilter: { matchType: "CONTAINS", value: p.gscFilter } } } } : {};
  const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/${p.ga4Property}:runReport`,
    { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ dateRanges: [{ startDate: "7daysAgo", endDate: "today" }], metrics: [{ name: "sessions" }], ...filter }) }).then((x) => x.json());
  return { sessions: Number(r.rows?.[0]?.metricValues?.[0]?.value || 0) };
}

// --- run per property -------------------------------------------------------
const scToken = await googleToken("https://www.googleapis.com/auth/webmasters.readonly").catch(() => null);
const gaToken = await googleToken("https://www.googleapis.com/auth/analytics.readonly").catch(() => null);
const results = [];

for (const p of PROPERTIES) {
  const row = { name: p.name, week, tier: p.tier };
  try { Object.assign(row, await pageSpeed(p.url)); } catch { row.perf = null; }

  // on-page SEO: extract + hash-skip unchanged pages
  let audit = null, hash = null;
  try {
    const html = await fetch(p.url).then((r) => r.text());
    const ex = extractSeo(html); hash = ex.hash;
    const prev = (await db.from("brand_snapshots").select("content_hash,seo_audit").eq("name", p.name).order("week", { ascending: false }).limit(1)).data?.[0];
    if (prev && prev.content_hash === hash && prev.seo_audit) {
      audit = prev.seo_audit;                       // reuse — no LLM call
    } else {
      const out = await callGemini(
        `On-page SEO audit. Return JSON {"score":0-100,"issues":[{"severity":"high|med|low","note":""}],"quick_wins":[""]}. Judge title, meta description, heading structure, alt coverage, schema, content depth. Fields:\n${JSON.stringify(ex.fields)}`,
        { json: true });
      audit = parseJson(out);                       // one small call, trimmed input
    }
  } catch {}
  row.content_hash = hash; row.seo_audit = audit;

  // rankings + traffic only for full/path tiers
  if ((p.tier === "full" || p.tier === "path")) {
    if (scToken) try { const g = await gsc(p, scToken); Object.assign(row, { clicks: g.clicks, impressions: g.impressions, avg_position: g.avg_position, _topQ: g.top }); } catch {}
    if (gaToken && p.ga4Property) try { Object.assign(row, await ga4(p, gaToken)); } catch {}
  }

  // regression vs last week (perf drop / seo drop / new broken links)
  const last = (await db.from("brand_snapshots").select("perf,seo,broken_links").eq("name", p.name).lt("week", week).order("week", { ascending: false }).limit(1)).data?.[0];
  row._regressions = [];
  if (last) {
    if (row.perf != null && last.perf != null && last.perf - row.perf >= 10) row._regressions.push(`perf ${last.perf}→${row.perf}`);
    if (row.seo != null && last.seo != null && last.seo - row.seo >= 10) row._regressions.push(`SEO ${last.seo}→${row.seo}`);
    if (row.broken_links > (last.broken_links || 0)) row._regressions.push(`+${row.broken_links - (last.broken_links || 0)} broken links`);
  }

  await db.from("brand_snapshots").insert({ name: row.name, week, perf: row.perf, seo: row.seo, accessibility: row.accessibility,
    lcp: row.lcp, cls: row.cls, broken_links: row.broken_links, clicks: row.clicks, impressions: row.impressions,
    avg_position: row.avg_position, sessions: row.sessions, content_hash: hash, seo_audit: audit });
  results.push(row);
}

// --- one weekly narrative (final synthesis call, compact input) -------------
const compact = results.map((r) => ({ name: r.name, tier: r.tier, perf: r.perf, seo: r.seo, a11y: r.accessibility,
  lcp: r.lcp, broken: r.broken_links, clicks: r.clicks, sessions: r.sessions, avg_position: r.avg_position,
  seo_score: r.seo_audit?.score, top_issues: (r.seo_audit?.issues || []).slice(0, 2), regressions: r._regressions }));

const report = await callGemini(
`Write my weekly brand report across ${results.length} properties. Structure:
1) Headline: anything urgent (regressions, broken links, big drops) FIRST.
2) Full-insight sites (HoN, Portfolio + its apps): rankings + traffic + SEO.
3) Health watch (perf-only sites): flag only the ones that regressed or scored poorly; don't list healthy ones one by one — summarize "N healthy".
4) Top 3 prioritized actions across everything.
Be specific, use the numbers, no fluff. DATA:\n${JSON.stringify(compact)}`);

await notifyEmail(`📊 Weekly brand report — ${week}`, `<pre style="white-space:pre-wrap">${report}</pre>`);
console.log(report);
