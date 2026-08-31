// lib/slot.js — which scheduled slot is a run standing in for?
//
// WHY THIS EXISTS
//
// GitHub stopped reliably dispatching `schedule` events for this repo on 2026-08-27. A dispatcher
// on the control dashboard now fires the runs GitHub drops. But GitHub often delivers the SAME run
// hours later anyway, so the agent runs twice.
//
// The run gate stops that: when GitHub's late trigger finally arrives, the agent checks whether
// that particular scheduled slot has already been done, and exits quietly if so. This file answers
// the only hard question in that design — WHICH SLOT IS THIS?
//
// ⚠️ Get this wrong and a run is silently skipped that should have happened, which is exactly the
// invisible failure the whole project exists to eliminate. It is covered by `npm run eval:slot`.
//
// A "slot" is the most recent moment a cron fired, at or before a given time. Not "today's date" —
// that would collapse the five daily firings of a 2-hourly agent into one. Not per-agent — several
// workflows declare two crons and each needs its own slot.

const MINUTE = 60000;

// 32 days. A monthly cron ("23 11 1 * *") can be 31 days behind, and the fleet has two of them.
// Anything shorter silently returns null for those and the gate then fails open — a duplicate,
// not a missed run, but still wrong.
const MAX_LOOKBACK_MIN = 32 * 24 * 60;

/**
 * Does one cron field match one value?
 * Handles `*`, lists (`1,4`), ranges (`1-5`), steps (`*​/2`), and stepped ranges (`0-20/5`).
 *
 * Deliberately identical in behaviour to the matcher in the dashboard's lib/agents-meta.js. The
 * gate and the dispatcher must agree about slots or they will disagree about duplicates; matching
 * implementations is how that is guaranteed.
 */
export function matchField(value, field) {
  if (field === "*") return true;
  for (const tok of String(field).split(",")) {
    const [rangePart, stepPart] = tok.split("/");
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isFinite(step) || step < 1) continue;

    if (rangePart === "*") {
      if (value % step === 0) return true;
      continue;
    }
    if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-").map(Number);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      if (value >= a && value <= b && (value - a) % step === 0) return true;
      continue;
    }
    const n = Number(rangePart);
    if (!Number.isFinite(n)) continue;
    if (stepPart) {
      // "5/2" — from 5 upwards in steps of 2.
      if (value >= n && (value - n) % step === 0) return true;
    } else if (n === value) return true;
  }
  return false;
}

/**
 * Does `cron` fire at exactly this minute? UTC; seconds are ignored.
 *
 * NOTE ON day-of-month vs day-of-week: POSIX cron ORs them when both are restricted. This ANDs
 * them, matching the dashboard's existing matcher. **No cron in this fleet restricts both**
 * (the two monthly ones use `1 * *`, every weekly one uses `* * <dow>`), so the two readings
 * cannot differ here. If a cron ever restricts both, revisit this and the dashboard together.
 */
export function cronHits(cron, date) {
  const p = String(cron || "").trim().split(/\s+/);
  if (p.length !== 5) return false;
  const [mi, ho, dom, mo, dow] = p;

  // GitHub accepts 7 for Sunday as well as 0.
  const day = date.getUTCDay();
  const dowOk = matchField(day, dow) || (day === 0 && matchField(7, dow));

  return (
    matchField(date.getUTCMinutes(), mi) &&
    matchField(date.getUTCHours(), ho) &&
    matchField(date.getUTCDate(), dom) &&
    matchField(date.getUTCMonth() + 1, mo) &&
    dowOk
  );
}

/**
 * The most recent time `cron` fired, at or before `now`.
 *
 * @returns {Date|null} null if the cron is malformed, or did not fire in the last 32 days.
 *
 * A run arriving MORE THAN ONE FULL PERIOD late resolves to the CURRENT period, not the one it was
 * originally sent for. If a 2-hourly agent's 00:07 trigger is delivered at 04:30, this returns
 * 04:07. That is deliberate: the work gets done for the period that is actually current, and the
 * dispatcher then sees a run since 04:07 and stands down. GitHub does not tell us which slot a late
 * delivery was meant for, so this is the only answer available — and it is the safe one, because it
 * errs toward running rather than skipping.
 */
export function slotFor(cron, now = new Date()) {
  const p = String(cron || "").trim().split(/\s+/);
  if (p.length !== 5) return null;

  const t = new Date(now.getTime());
  t.setUTCSeconds(0, 0);

  for (let i = 0; i <= MAX_LOOKBACK_MIN; i++) {
    if (cronHits(cron, t)) return new Date(t.getTime());
    t.setTime(t.getTime() - MINUTE);
  }
  return null;
}

/** Stable, readable slot identity: the UTC minute, e.g. "2026-08-31T02:13Z". */
export function slotKey(date) {
  return date ? `${date.toISOString().slice(0, 16)}Z` : null;
}

/**
 * The kv key a claim lives under. Includes the cron so two crons of the same workflow never share
 * a slot — the bug the dispatcher's own per-agent de-dupe still has.
 */
export function claimKey(agent, cron, slot) {
  return `gate:${agent}:${String(cron).trim()}:${slotKey(slot)}`;
}
