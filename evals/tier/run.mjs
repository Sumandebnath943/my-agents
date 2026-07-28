// evals/tier/run.mjs
// Guards the 🟡-tier ceiling framework's core contract: enhancement-never-dependency. Offline —
// we remove Supabase env so the tracker can't reach a DB, proving the agent's baseline still runs
// when tracking is unavailable, when the ceiling is hit, and when the add-on itself errors.
import "../_env.mjs";
import { runCases, isMain } from "../_lib.mjs";
import { pickPeriod, decide, withCeiling, samePeriod, TIER_PROVIDERS } from "../../lib/tier.js";

export async function run() {
  // Force offline: no Supabase => getUsage/bump throw and are swallowed (best-effort).
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_KEY;

  // decide()
  const decideRes = runCases("tier · decide(count, ceiling)", [
    { id: "under-ceiling", ok: decide(0, 100) === "enhanced" },
    { id: "just-under", ok: decide(99, 100) === "enhanced" },
    { id: "at-ceiling", ok: decide(100, 100) === "exhausted" },
    { id: "over-ceiling", ok: decide(150, 100) === "exhausted" },
  ], (c) => ({ ok: c.ok }));

  // pickPeriod()
  const jul = new Date(Date.UTC(2026, 6, 15, 12, 0, 0)); // 2026-07-15
  const cal = pickPeriod("calendar_month", jul);
  const rollNew = pickPeriod("rolling_30d", jul, null);
  const notExpired = { period_start: "2026-07-10T00:00:00.000Z", period_end: "2026-08-09T00:00:00.000Z" };
  const rollCont = pickPeriod("rolling_30d", jul, notExpired);
  const periodRes = runCases("tier · pickPeriod()", [
    { id: "calendar-start-1st", ok: cal.start === "2026-07-01T00:00:00.000Z" },
    { id: "calendar-end-next-1st", ok: cal.end === "2026-08-01T00:00:00.000Z" },
    { id: "rolling-new-30d-window", ok: rollNew.start === jul.toISOString() && rollNew.end === new Date(jul.getTime() + 30 * 864e5).toISOString() },
    { id: "rolling-continues-open-period", ok: rollCont.start === notExpired.period_start && rollCont.end === notExpired.period_end },
  ], (c) => ({ ok: c.ok }));

  // anchored_month — a provider that renews on ITS OWN billing day, not the 1st. Firecrawl's
  // /v1/team/credit-usage reports a 22nd→22nd period; quoting the 1st was up to three weeks wrong.
  const anch = (d, day) => pickPeriod("anchored_month", d, null, { anchorDay: day });
  const midPeriod = anch(new Date(Date.UTC(2026, 6, 25)), 22);   // Jul 25, anchor 22 -> Jul 22..Aug 22
  const beforeAnchor = anch(new Date(Date.UTC(2026, 6, 10)), 22); // Jul 10, anchor 22 -> Jun 22..Jul 22
  const onAnchor = anch(new Date(Date.UTC(2026, 6, 22)), 22);     // exactly on the boundary
  const yearEdge = anch(new Date(Date.UTC(2026, 0, 5)), 22);      // Jan 5 -> must roll back to Dec 22
  const clamped = anch(new Date(Date.UTC(2026, 6, 25)), 31);      // 31 is impossible in Feb -> clamp 28
  const anchoredRes = runCases("tier · pickPeriod('anchored_month')", [
    { id: "mid-period-starts-at-this-months-anchor", ok: midPeriod.start === "2026-07-22T00:00:00.000Z" },
    { id: "mid-period-ends-at-next-anchor", ok: midPeriod.end === "2026-08-22T00:00:00.000Z" },
    { id: "before-anchor-rolls-back-a-month", ok: beforeAnchor.start === "2026-06-22T00:00:00.000Z" && beforeAnchor.end === "2026-07-22T00:00:00.000Z" },
    { id: "exactly-on-anchor-starts-today", ok: onAnchor.start === "2026-07-22T00:00:00.000Z" },
    { id: "january-rolls-back-across-year-end", ok: yearEdge.start === "2025-12-22T00:00:00.000Z" && yearEdge.end === "2026-01-22T00:00:00.000Z" },
    // Anchor 31 clamps to 28. Jul 25 is BEFORE the 28th, so the live window is Jun 28 -> Jul 28.
    { id: "anchor-clamped-to-28-so-every-month-has-it", ok: clamped.start === "2026-06-28T00:00:00.000Z" && clamped.end === "2026-07-28T00:00:00.000Z" },
    { id: "clamped-anchor-after-the-day-uses-this-month", ok: anch(new Date(Date.UTC(2026, 6, 29)), 31).start === "2026-07-28T00:00:00.000Z" },
    { id: "february-still-has-the-clamped-anchor", ok: anch(new Date(Date.UTC(2026, 1, 28)), 31).start === "2026-02-28T00:00:00.000Z" },
    { id: "missing-anchor-behaves-like-the-1st", ok: anch(new Date(Date.UTC(2026, 6, 25)), undefined).start === "2026-07-01T00:00:00.000Z" },
    { id: "window-is-contiguous-month-to-month", ok: beforeAnchor.end === midPeriod.start },
    { id: "firecrawl-config-matches-its-real-billing-day", ok: TIER_PROVIDERS.firecrawl.cadence === "anchored_month" && TIER_PROVIDERS.firecrawl.anchorDay === 22 },
    { id: "firecrawl-ceiling-matches-real-plan-credits", ok: TIER_PROVIDERS.firecrawl.ceiling === 1000 },
    { id: "calendar-providers-unchanged", ok: TIER_PROVIDERS.tavily.cadence === "calendar_month" && TIER_PROVIDERS.cohere.cadence === "calendar_month" },
  ], (c) => ({ ok: c.ok }));

  // samePeriod() — the seam between a STORED row and pickPeriod(). Postgres hands back
  // "2026-07-01T00:00:00+00:00"; JS toISOString() produces "2026-07-01T00:00:00.000Z". Same instant,
  // different spelling — so comparing them as TEXT is always false. That pinned every add-on counter
  // at 1 and left the ceiling guard permanently unable to fire. Fixtures below are the REAL shapes
  // read back from Supabase, not JS-formatted stand-ins; the old suite only ever used the latter,
  // which is exactly why it stayed green through the whole outage.
  const calStart = pickPeriod("calendar_month", jul).start;   // "2026-07-01T00:00:00.000Z"
  const periodMatchRes = runCases("tier · samePeriod() — stored row vs current period", [
    { id: "postgres-offset-form-matches", ok: samePeriod("2026-07-01T00:00:00+00:00", calStart) === true },
    { id: "identical-js-form-matches", ok: samePeriod("2026-07-01T00:00:00.000Z", calStart) === true },
    { id: "non-utc-offset-same-instant-matches", ok: samePeriod("2026-07-01T05:30:00+05:30", calStart) === true },
    { id: "previous-month-does-not-match", ok: samePeriod("2026-06-01T00:00:00+00:00", calStart) === false },
    { id: "next-month-does-not-match", ok: samePeriod("2026-08-01T00:00:00+00:00", calStart) === false },
    { id: "one-second-off-does-not-match", ok: samePeriod("2026-07-01T00:00:01+00:00", calStart) === false },
    { id: "null-row-does-not-match", ok: samePeriod(null, calStart) === false },
    { id: "undefined-row-does-not-match", ok: samePeriod(undefined, calStart) === false },
    { id: "garbage-does-not-match", ok: samePeriod("not-a-date", calStart) === false },
    { id: "empty-string-does-not-match", ok: samePeriod("", calStart) === false },
  ], (c) => ({ ok: c.ok }));

  // withCeiling() — the enhancement-never-dependency contract (offline: usage read fails → best-effort)
  const enhancedOk = await withCeiling("cohere", async () => "ENHANCED", async () => "BASELINE");
  const enhancedThrows = await withCeiling("cohere", async () => { throw new Error("add-on down"); }, async () => "BASELINE");
  const guardRes = runCases("tier · withCeiling() fallback", [
    { id: "addon-works-uses-enhanced", ok: enhancedOk.used === "enhanced" && enhancedOk.result === "ENHANCED" },
    { id: "addon-fails-uses-baseline", ok: enhancedThrows.used === "baseline" && enhancedThrows.result === "BASELINE" },
    { id: "baseline-carries-error", ok: typeof enhancedThrows.error === "string" && enhancedThrows.error.includes("add-on down") },
  ], (c) => ({ ok: c.ok }));

  return [decideRes, periodRes, anchoredRes, periodMatchRes, guardRes];
}

if (isMain(import.meta.url)) {
  const results = await run();
  process.exit(results.some((r) => r.fail) ? 1 : 0);
}
