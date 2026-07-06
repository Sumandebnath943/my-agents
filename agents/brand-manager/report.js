// agents/brand-manager/report.js — WEEKLY rollup. Aggregates the per-page brand_pages
// data into one row per property, adds GSC rankings + GA4 traffic (full/path tiers),
// flags week-over-week regressions, writes brand_snapshots (history + Overview card),
// then Gemini writes the narrative → email + a short Telegram summary.
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { PROPERTIES } from "./properties.js";
import { googleToken } from "../../lib/google-auth.js";
import { callGemini } from "../../lib/llm.js";
import { notifyEmail, notifyTelegram, tgEscape } from "../../lib/notify.js";
import { renderEmail, mdToHtml } from "../../lib/email-template.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));
const week = new Date().toISOString().slice(0, 10);
const avg = (a) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : null);

async function gsc(p, token) {
  const end = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
  const start = new Date(Date.now() - 9 * 864e5).toISOString().slice(0, 10);
  const body = { startDate: start, endDate: end, dimensions: ["query"], rowLimit: 10,
    ...(p.gscFilter ? { dimensionFilterGroups: [{ filters: [{ dimension: "page", operator: "contains", expression: p.gscFilter }] }] } : {}) };
  const r = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(p.gscSite)}/searchAnalytics/query`,
    { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json());
  const rows = r.rows || [];
  return { clicks: rows.reduce((s, x) => s + x.clicks, 0), impressions: rows.reduce((s, x) => s + x.impressions, 0),
    avg_position: rows.length ? Math.round(rows.reduce((s, x) => s + x.position, 0) / rows.length * 10) / 10 : null };
}
async function ga4(p, token) {
  const filter = p.gscFilter ? { dimensionFilter: { filter: { fieldName: "pagePath", stringFilter: { matchType: "CONTAINS", value: p.gscFilter } } } } : {};
  const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/${p.ga4Property}:runReport`,
    { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ dateRanges: [{ startDate: "7daysAgo", endDate: "today" }], metrics: [{ name: "sessions" }], ...filter }) }).then((x) => x.json());
  return { sessions: Number(r.rows?.[0]?.metricValues?.[0]?.value || 0) };
}

const { data: pages } = await db.from("brand_pages").select("*");
const byProp = {};
for (const pg of pages || []) (byProp[pg.property] ||= []).push(pg);

const scToken = await googleToken("https://www.googleapis.com/auth/webmasters.readonly").catch(() => null);
const gaToken = await googleToken("https://www.googleapis.com/auth/analytics.readonly").catch(() => null);

const results = [];
for (const p of PROPERTIES) {
  const pgs = byProp[p.name] || [];
  const perf = avg(pgs.map((x) => x.perf).filter((v) => v != null));
  const seo = avg(pgs.map((x) => x.seo).filter((v) => v != null));
  const a11y = avg(pgs.map((x) => x.accessibility).filter((v) => v != null));
  const broken = pgs.reduce((s, x) => s + (x.broken_links || 0), 0);
  const seoScore = avg(pgs.map((x) => x.seo_audit?.score).filter((v) => v != null));
  const issues = [];
  for (const x of pgs) for (const i of x.seo_audit?.issues || []) if (i.severity !== "low" && i.note) issues.push(i.note);
  const worst = pgs.filter((x) => x.perf != null).sort((a, b) => a.perf - b.perf)[0]?.url || null;

  const row = { name: p.name, week, tier: p.tier, pages: pgs.length, perf, seo, accessibility: a11y, broken_links: broken,
    seo_audit: { score: seoScore, issues: [...new Set(issues)].slice(0, 5).map((note) => ({ note })) }, worst };

  if (p.tier === "full" || p.tier === "path") {
    if (scToken) try { Object.assign(row, await gsc(p, scToken)); } catch {}
    if (gaToken && p.ga4Property) try { Object.assign(row, await ga4(p, gaToken)); } catch {}
  }

  const last = (await db.from("brand_snapshots").select("perf,seo,broken_links").eq("name", p.name).lt("week", week).order("week", { ascending: false }).limit(1)).data?.[0];
  row._regressions = [];
  if (last) {
    if (row.perf != null && last.perf != null && last.perf - row.perf >= 8) row._regressions.push(`perf ${last.perf}→${row.perf}`);
    if (row.seo != null && last.seo != null && last.seo - row.seo >= 8) row._regressions.push(`SEO ${last.seo}→${row.seo}`);
    if (row.broken_links > (last.broken_links || 0)) row._regressions.push(`+${row.broken_links - (last.broken_links || 0)} broken links`);
  }

  await db.from("brand_snapshots").insert({ name: row.name, week, perf: row.perf, seo: row.seo, accessibility: row.accessibility,
    broken_links: row.broken_links, clicks: row.clicks, impressions: row.impressions, avg_position: row.avg_position, sessions: row.sessions, seo_audit: row.seo_audit });
  results.push(row);
}

const compact = results.map((r) => ({ name: r.name, tier: r.tier, pages: r.pages, perf: r.perf, seo: r.seo, a11y: r.accessibility,
  broken: r.broken_links, seo_score: r.seo_audit?.score, clicks: r.clicks, sessions: r.sessions, avg_position: r.avg_position,
  regressions: r._regressions, worst: r.worst }));

const report = await callGemini(
`Write my weekly brand report across ${results.length} web properties (some are multi-page sites, so "pages" is how many were tracked). Structure:
1) Headline: anything urgent FIRST — regressions, broken links, big drops.
2) Full-insight sites (HoN, Portfolio + its apps): rankings + traffic + SEO + the weakest page (worst).
3) Health watch (perf-only sites): flag only regressed/poor ones; summarize the rest as "N healthy".
4) Top 3 prioritized actions across everything.
Be specific, use the numbers, no fluff. DATA:\n${JSON.stringify(compact)}`);

const totalPages = results.reduce((s, r) => s + r.pages, 0);
const regr = results.filter((r) => r._regressions.length);
const brokenTotal = results.reduce((s, r) => s + (r.broken_links || 0), 0);

await notifyEmail(`📊 Weekly brand report — ${week}`, renderEmail({
  title: "Weekly Brand Report", subtitle: week, kicker: "BRAND & SEO", accent: "#185FA5",
  blocks: [
    { type: "tiles", items: [
      { ramp: "blue", label: "Properties", value: String(results.length) },
      { ramp: "blue", label: "Pages tracked", value: String(totalPages) },
      { ramp: regr.length ? "red" : "green", label: "Regressions", value: String(regr.length) },
      { ramp: brokenTotal ? "amber" : "green", label: "Broken links", value: String(brokenTotal) },
    ] },
    { type: "text", html: mdToHtml(report) },
  ],
  footer: "Brand Manager · weekly rollup across your web properties",
}));
let tg = `📊 <b>Brand report — ${week}</b>\n${results.length} properties · ${totalPages} pages tracked\nEmailed the full breakdown.`;
if (regr.length) tg += `\n⚠️ Regressions: ${tgEscape(regr.map((r) => r.name).join(", "))}`;
await notifyTelegram(tg, { html: true });
console.log(report);
