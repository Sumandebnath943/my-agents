// evals/tier/run.mjs
// Guards the 🟡-tier ceiling framework's core contract: enhancement-never-dependency. Offline —
// we remove Supabase env so the tracker can't reach a DB, proving the agent's baseline still runs
// when tracking is unavailable, when the ceiling is hit, and when the add-on itself errors.
import "../_env.mjs";
import { runCases, isMain } from "../_lib.mjs";
import { pickPeriod, decide, withCeiling } from "../../lib/tier.js";

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

  // withCeiling() — the enhancement-never-dependency contract (offline: usage read fails → best-effort)
  const enhancedOk = await withCeiling("cohere", async () => "ENHANCED", async () => "BASELINE");
  const enhancedThrows = await withCeiling("cohere", async () => { throw new Error("add-on down"); }, async () => "BASELINE");
  const guardRes = runCases("tier · withCeiling() fallback", [
    { id: "addon-works-uses-enhanced", ok: enhancedOk.used === "enhanced" && enhancedOk.result === "ENHANCED" },
    { id: "addon-fails-uses-baseline", ok: enhancedThrows.used === "baseline" && enhancedThrows.result === "BASELINE" },
    { id: "baseline-carries-error", ok: typeof enhancedThrows.error === "string" && enhancedThrows.error.includes("add-on down") },
  ], (c) => ({ ok: c.ok }));

  return [decideRes, periodRes, guardRes];
}

if (isMain(import.meta.url)) {
  const results = await run();
  process.exit(results.some((r) => r.fail) ? 1 : 0);
}
