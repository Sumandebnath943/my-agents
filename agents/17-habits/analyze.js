// agents/17-habits/analyze.js
// The health analysis engine — pure, so it can be unit-eval'd offline and reused by the agent,
// the Telegram commands and the dashboard without three copies drifting apart.
//
// Context: `habits` has stored sleep_time and wake_time since Round 1, but NOTHING has ever
// computed the number that actually matters — how long you slept. Everything here derives from the
// columns already in the table, so the whole back-history gains these numbers retroactively.
//
// Honesty rule (the same one the winners loop follows): with a handful of days, any "pattern" is
// noise. Every comparison reports its sample size and is withheld entirely below a floor, rather
// than dressing up a coincidence as an insight.

export const MIN_DAYS = 10;      // total logged days before findings are offered at all
export const MIN_PER_BAND = 3;   // days on each side before two groups are compared
const MAX_PLAUSIBLE_SLEEP = 16;  // hours; beyond this the times are mis-parsed, not a long night

/** "1:30" | "01:30" | "8" -> minutes past midnight. null when unreadable. */
export function parseTime(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2] ?? 0);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Hours slept, crossing midnight correctly: 01:30 -> 08:00 is 6.5h, and 23:00 -> 07:00 is 8h.
 * Returns null when either time is unreadable, or when the result is implausible (which means the
 * times were mis-parsed — reporting a 23-hour night would be worse than reporting nothing).
 */
export function sleepHours(sleep_time, wake_time) {
  const a = parseTime(sleep_time), b = parseTime(wake_time);
  if (a === null || b === null) return null;
  let mins = b - a;
  if (mins <= 0) mins += 1440;
  const hours = Math.round((mins / 60) * 100) / 100;
  return hours > MAX_PLAUSIBLE_SLEEP ? null : hours;
}

const num = (v) => { const n = v === null || v === undefined || v === "" ? NaN : Number(v); return Number.isFinite(n) ? n : null; };
const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

/** Add derived fields to raw habit rows. Never mutates the input. */
export function enrich(rows) {
  return (Array.isArray(rows) ? rows : []).filter(Boolean).map((r) => ({
    ...r,
    sleep_hours: sleepHours(r.sleep_time, r.wake_time),
    productivity: num(r.productivity),
    mood: num(r.mood),
    exercised: !!r.exercised,
    read_today: !!r.read_today,
  }));
}

/** Consecutive days logged, counting back from today (yesterday still counts — today may be unlogged). */
export function streak(rows, today = new Date()) {
  const days = new Set((Array.isArray(rows) ? rows : []).map((r) => String(r?.log_date || "").slice(0, 10)));
  const iso = (d) => d.toISOString().slice(0, 10);
  const base = new Date(`${iso(today)}T00:00:00Z`);
  let n = 0;
  // Allow the run to start at today OR yesterday, so an unlogged today doesn't erase the streak.
  let cursor = days.has(iso(base)) ? base : new Date(base.getTime() - 86400000);
  while (days.has(iso(cursor))) { n++; cursor = new Date(cursor.getTime() - 86400000); }
  return n;
}

/** Headline averages over whatever is present. */
export function summary(rows) {
  const e = enrich(rows);
  const sleeps = e.map((r) => r.sleep_hours).filter((v) => v !== null);
  return {
    days: e.length,
    avg_sleep: avg(sleeps),
    avg_productivity: avg(e.map((r) => r.productivity).filter((v) => v !== null)),
    avg_mood: avg(e.map((r) => r.mood).filter((v) => v !== null)),
    exercise_days: e.filter((r) => r.exercised).length,
    read_days: e.filter((r) => r.read_today).length,
    unreadable_sleep: e.filter((r) => r.sleep_hours === null && (r.sleep_time || r.wake_time)).length,
  };
}

/** Daily series for charts, oldest first. */
export function series(rows) {
  return enrich(rows)
    .filter((r) => r.log_date)
    .sort((a, b) => String(a.log_date).localeCompare(String(b.log_date)))
    .map((r) => ({ date: String(r.log_date).slice(0, 10), sleep: r.sleep_hours, productivity: r.productivity, mood: r.mood, exercised: r.exercised }));
}

/** Average of a metric per weekday (0 = Sunday), for spotting a rough Monday or a strong Thursday. */
export function weekdayPattern(rows, metric = "productivity") {
  const buckets = Array.from({ length: 7 }, () => []);
  for (const r of enrich(rows)) {
    const t = new Date(`${String(r.log_date || "").slice(0, 10)}T00:00:00Z`).getTime();
    if (!Number.isFinite(t) || r[metric] === null) continue;
    buckets[new Date(t).getUTCDay()].push(r[metric]);
  }
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return buckets.map((vals, i) => ({ day: names[i], n: vals.length, avg: avg(vals) }));
}

/**
 * Compare a metric across two groups of days — the readable form of a correlation.
 * "On 7h+ nights productivity averaged 4.1 vs 3.2 under 6h" beats "r = 0.43" for acting on.
 * Returns null unless BOTH groups clear MIN_PER_BAND, so a lopsided sample can't fake a finding.
 */
export function compareGroups(rows, { split, metric, lowLabel, highLabel, minPerBand = MIN_PER_BAND }) {
  const e = enrich(rows);
  const lo = [], hi = [];
  for (const r of e) {
    const v = r[metric];
    if (v === null) continue;
    const side = split(r);
    if (side === true) hi.push(v);
    else if (side === false) lo.push(v);
  }
  if (lo.length < minPerBand || hi.length < minPerBand) return null;
  const [a, b] = [avg(hi), avg(lo)];
  return { metric, highLabel, lowLabel, high: a, low: b, highN: hi.length, lowN: lo.length, delta: Math.round((a - b) * 10) / 10 };
}

const pct = (d, base) => (base ? Math.round((d / base) * 100) : 0);

/**
 * The findings the agent/dashboard actually shows. Deliberately few and deliberately gated:
 * below MIN_DAYS it returns nothing and says why, instead of inventing a pattern from noise.
 */
export function findings(rows, { minDays = MIN_DAYS } = {}) {
  const e = enrich(rows);
  if (e.length < minDays) {
    return { ready: false, reason: `Only ${e.length} day(s) logged — patterns need at least ${minDays} to mean anything.`, items: [] };
  }
  const items = [];
  const sleeps = e.map((r) => r.sleep_hours).filter((v) => v !== null);
  const median = sleeps.length ? [...sleeps].sort((a, b) => a - b)[Math.floor(sleeps.length / 2)] : null;

  // Sleep -> productivity, split at 7h (the common-sense threshold, not a fitted one).
  const sp = compareGroups(e, { split: (r) => (r.sleep_hours === null ? null : r.sleep_hours >= 7), metric: "productivity", highLabel: "7h+ sleep", lowLabel: "under 7h" });
  if (sp && Math.abs(sp.delta) >= 0.3) {
    items.push({ kind: "sleep_productivity", text: `After ${sp.highLabel}, productivity averaged ${sp.high}/5 — vs ${sp.low}/5 ${sp.lowLabel}. That's ${sp.delta > 0 ? "+" : ""}${sp.delta} (${sp.highN} vs ${sp.lowN} days).`, delta: sp.delta });
  }
  // Sleep -> mood.
  const sm = compareGroups(e, { split: (r) => (r.sleep_hours === null ? null : r.sleep_hours >= 7), metric: "mood", highLabel: "7h+ sleep", lowLabel: "under 7h" });
  if (sm && Math.abs(sm.delta) >= 0.3) {
    items.push({ kind: "sleep_mood", text: `Mood ran ${sm.high}/5 after ${sm.highLabel} versus ${sm.low}/5 ${sm.lowLabel} (${sm.highN} vs ${sm.lowN} days).`, delta: sm.delta });
  }
  // Exercise -> productivity.
  const ep = compareGroups(e, { split: (r) => r.exercised, metric: "productivity", highLabel: "days you exercised", lowLabel: "days you didn't" });
  if (ep && Math.abs(ep.delta) >= 0.3) {
    items.push({ kind: "exercise_productivity", text: `On ${ep.highLabel}, productivity averaged ${ep.high}/5 — ${Math.abs(ep.delta)} ${ep.delta > 0 ? "higher" : "lower"} than ${ep.lowLabel} (${ep.highN} vs ${ep.lowN} days).`, delta: ep.delta });
  }
  // Exercise -> mood.
  const em = compareGroups(e, { split: (r) => r.exercised, metric: "mood", highLabel: "days you exercised", lowLabel: "days you didn't" });
  if (em && Math.abs(em.delta) >= 0.3) {
    items.push({ kind: "exercise_mood", text: `Mood averaged ${em.high}/5 on ${em.highLabel} vs ${em.low}/5 on ${em.lowLabel} (${em.highN} vs ${em.lowN} days).`, delta: em.delta });
  }

  const s = summary(e);
  return {
    ready: true,
    reason: null,
    items,
    context: {
      days: s.days, median_sleep: median, avg_sleep: s.avg_sleep,
      avg_productivity: s.avg_productivity, avg_mood: s.avg_mood,
      exercise_rate: pct(s.exercise_days, s.days),
      unreadable_sleep: s.unreadable_sleep,
    },
  };
}
