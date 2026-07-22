// evals/health/run.mjs
// Guards the health analysis engine (agents/17-habits/analyze.js). Pure + offline.
//
// Two things carry the weight here:
//   1. Sleep duration across midnight — the number the fleet has never computed. "slept 23:00,
//      woke 07:00" is 8 hours, not minus sixteen.
//   2. The honesty gate — with a handful of days every "pattern" is noise, so findings must be
//      withheld and SAY they're withheld, rather than dressing a coincidence up as an insight.
import "../_env.mjs";
import { runCases, isMain } from "../_lib.mjs";
import { parseTime, sleepHours, enrich, streak, summary, series, weekdayPattern, compareGroups, findings, MIN_DAYS } from "../../agents/17-habits/analyze.js";

const day = (n) => new Date(Date.UTC(2026, 6, n)).toISOString().slice(0, 10); // 2026-07-0n
const row = (n, o = {}) => ({ log_date: day(n), sleep_time: "23:00", wake_time: "07:00", productivity: 3, mood: 3, exercised: false, read_today: false, ...o });

export function run() {
  const times = runCases("health · time parsing", [
    { id: "HH:MM", check: () => parseTime("07:30") === 450 },
    { id: "H:MM", check: () => parseTime("7:30") === 450 },
    { id: "bare hour", check: () => parseTime("8") === 480 },
    { id: "midnight", check: () => parseTime("00:00") === 0 },
    { id: "whitespace tolerated", check: () => parseTime("  7:30 ") === 450 },
    { id: "empty -> null", check: () => parseTime("") === null },
    { id: "null -> null", check: () => parseTime(null) === null },
    { id: "garbage -> null", check: () => parseTime("late") === null },
    { id: "impossible hour -> null", check: () => parseTime("25:00") === null },
    { id: "impossible minute -> null", check: () => parseTime("07:99") === null },
  ], (c) => ({ ok: c.check() }));

  const sleep = runCases("health · sleep duration (the number nothing ever computed)", [
    { id: "same-day 01:30 -> 08:00 = 6.5h", check: () => sleepHours("01:30", "08:00") === 6.5 },
    { id: "ACROSS MIDNIGHT 23:00 -> 07:00 = 8h", check: () => sleepHours("23:00", "07:00") === 8 },
    { id: "late night 00:45 -> 06:15 = 5.5h", check: () => sleepHours("00:45", "06:15") === 5.5 },
    { id: "22:30 -> 06:00 = 7.5h", check: () => sleepHours("22:30", "06:00") === 7.5 },
    { id: "bare hours 1 -> 8 = 7h", check: () => sleepHours("1", "8") === 7 },
    { id: "equal times = full 24h wrap avoided -> null", check: () => sleepHours("08:00", "08:00") === null },
    { id: "implausible 23h -> null, not a fake long night", check: () => sleepHours("08:00", "07:00") === null },
    { id: "16h exactly is allowed", check: () => sleepHours("14:00", "06:00") === 16 },
    { id: "missing sleep -> null", check: () => sleepHours(null, "07:00") === null },
    { id: "missing wake -> null", check: () => sleepHours("23:00", null) === null },
    { id: "garbage -> null", check: () => sleepHours("bed", "up") === null },
  ], (c) => ({ ok: c.check() }));

  const rows10 = Array.from({ length: 10 }, (_, i) => row(i + 1));
  const enr = runCases("health · enrichment + summary", [
    { id: "adds sleep_hours to every row", check: () => enrich(rows10).every((r) => r.sleep_hours === 8) },
    { id: "does not mutate the input", check: () => { const src = [row(1)]; enrich(src); return src[0].sleep_hours === undefined; } },
    { id: "coerces productivity to a number", check: () => enrich([row(1, { productivity: "4" })])[0].productivity === 4 },
    { id: "blank productivity -> null, not 0", check: () => enrich([row(1, { productivity: "" })])[0].productivity === null },
    { id: "blank mood -> null, not 0", check: () => enrich([row(1, { mood: null })])[0].mood === null },
    { id: "averages ignore missing values", check: () => summary([row(1, { productivity: 4 }), row(2, { productivity: null })]).avg_productivity === 4 },
    { id: "counts unreadable sleep times", check: () => summary([row(1, { sleep_time: "??" })]).unreadable_sleep === 1 },
    { id: "a fully empty row isn't counted as unreadable", check: () => summary([row(1, { sleep_time: null, wake_time: null })]).unreadable_sleep === 0 },
    { id: "junk rows never throw", check: () => summary([null, undefined, {}]).days === 1 },
    { id: "series is oldest-first", check: () => { const s = series([row(3), row(1), row(2)]); return s[0].date === day(1) && s[2].date === day(3); } },
  ], (c) => ({ ok: c.check() }));

  const st = runCases("health · streak", [
    { id: "counts back from today", check: () => streak([row(20), row(19), row(18)], new Date("2026-07-20T12:00:00Z")) === 3 },
    { id: "an unlogged today doesn't reset it", check: () => streak([row(19), row(18)], new Date("2026-07-20T12:00:00Z")) === 2 },
    { id: "a gap ends it", check: () => streak([row(20), row(18), row(17)], new Date("2026-07-20T12:00:00Z")) === 1 },
    { id: "no logs -> 0", check: () => streak([], new Date("2026-07-20T12:00:00Z")) === 0 },
    { id: "duplicate dates counted once", check: () => streak([row(20), row(20), row(19)], new Date("2026-07-20T12:00:00Z")) === 2 },
  ], (c) => ({ ok: c.check() }));

  const wd = weekdayPattern(rows10, "productivity");
  const cmp = runCases("health · grouping + weekday", [
    { id: "weekday buckets cover all 7 days", check: () => wd.length === 7 && wd[0].day === "Sun" },
    { id: "weekday ignores rows missing the metric", check: () => weekdayPattern([row(1, { productivity: null })], "productivity").every((d) => d.avg === null) },
    { id: "compare needs BOTH sides", check: () => compareGroups([...Array.from({ length: 8 }, (_, i) => row(i + 1, { exercised: true }))], { split: (r) => r.exercised, metric: "productivity", highLabel: "h", lowLabel: "l" }) === null },
    { id: "compare works with enough on each side", check: () => {
        const rows = [...Array.from({ length: 4 }, (_, i) => row(i + 1, { exercised: true, productivity: 4 })),
                      ...Array.from({ length: 4 }, (_, i) => row(i + 5, { exercised: false, productivity: 2 }))];
        const c = compareGroups(rows, { split: (r) => r.exercised, metric: "productivity", highLabel: "h", lowLabel: "l" });
        return c.high === 4 && c.low === 2 && c.delta === 2;
      } },
    { id: "compare reports both sample sizes", check: () => {
        const rows = [...Array.from({ length: 4 }, (_, i) => row(i + 1, { exercised: true })), ...Array.from({ length: 5 }, (_, i) => row(i + 5, { exercised: false }))];
        const c = compareGroups(rows, { split: (r) => r.exercised, metric: "productivity", highLabel: "h", lowLabel: "l" });
        return c.highN === 4 && c.lowN === 5;
      } },
  ], (c) => ({ ok: c.check() }));

  // The honesty gate — the whole point of the engine.
  const thin = Array.from({ length: 5 }, (_, i) => row(i + 1));
  const strong = [
    ...Array.from({ length: 6 }, (_, i) => row(i + 1, { sleep_time: "23:00", wake_time: "07:00", productivity: 5, mood: 5 })),  // 8h
    ...Array.from({ length: 6 }, (_, i) => row(i + 7, { sleep_time: "01:30", wake_time: "06:00", productivity: 2, mood: 2 })),  // 4.5h
  ];
  const honesty = runCases("health · honesty gate (no patterns from noise)", [
    { id: `under ${MIN_DAYS} days -> withheld`, check: () => findings(thin).ready === false },
    { id: "withheld result says WHY", check: () => /at least 10/.test(findings(thin).reason || "") },
    { id: "withheld result has no items", check: () => findings(thin).items.length === 0 },
    { id: "empty input is safe", check: () => findings([]).ready === false },
    { id: "null input is safe", check: () => findings(null).ready === false },
    { id: "enough data -> ready", check: () => findings(strong).ready === true },
    { id: "detects the sleep→productivity gap", check: () => findings(strong).items.some((i) => i.kind === "sleep_productivity") },
    { id: "states both averages and the sample", check: () => { const f = findings(strong).items.find((i) => i.kind === "sleep_productivity"); return /5\/5/.test(f.text) && /2\/5/.test(f.text) && /6 vs 6 days/.test(f.text); } },
    { id: "detects the sleep→mood gap", check: () => findings(strong).items.some((i) => i.kind === "sleep_mood") },
    { id: "flat data yields NO findings", check: () => findings(Array.from({ length: 14 }, (_, i) => row(i + 1))).items.length === 0 },
    { id: "flat data is still 'ready' (just nothing to say)", check: () => findings(Array.from({ length: 14 }, (_, i) => row(i + 1))).ready === true },
    { id: "context carries the sample size", check: () => findings(strong).context.days === 12 },
    { id: "context reports the exercise rate", check: () => findings(strong).context.exercise_rate === 0 },
  ], (c) => ({ ok: c.check() }));

  return [times, sleep, enr, st, cmp, honesty];
}

if (isMain(import.meta.url)) {
  const results = run();
  if (results.some((r) => r.fail)) process.exit(1);
}
