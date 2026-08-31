// evals/slot/run.mjs — the run gate's slot calculation.
//
// WHY THIS SUITE IS THE ONE THAT MATTERS MOST
//
// The gate skips a scheduled run when its slot has already been done. If the slot is computed
// wrongly, a run is silently skipped that should have happened — and because a skip deliberately
// exits 0 so it does not trip Failure Triage, it looks GREEN. That is precisely the invisible
// failure the dispatcher project exists to eliminate, recreated by our own hand.
//
// So: every cron shape in the fleet, every boundary minute, and the awkward cases.
import { runCases, isMain } from "../_lib.mjs";
import { slotFor, slotKey, cronHits, matchField, claimKey } from "../../lib/slot.js";

const at = (iso) => new Date(iso);
const key = (cron, iso) => slotKey(slotFor(cron, at(iso)));

// Every cron the fleet actually declares, as of my-agents f0d6f6e. If a cron changes and this list
// is not updated, the coverage case below stops proving anything about the real fleet.
const FLEET_CRONS = [
  "11 */6 * * *", "27 2 * * *", "7 */2 * * *", "33 9 * * 1", "11 9 * * *",
  "37 2 * * 1-5", "39 10 * * 1", "11 11 * * 1", "41 1 * * *", "23 14 * * 0",
  "25 15 * * *", "13 2 * * *", "47 9 * * 0", "29 16 * * *", "1 6 * * 0",
  "49 10 * * 0", "35 1 * * *", "21 16 * * *", "43 6 * * 0", "21 15 * * 0",
  "56 8 * * 0", "4 9 1 * *", "38 15 * * *", "23 11 1 * *", "40 7 * * *",
  "15 */6 * * *", "50 6 * * *", "15 2 * * *", "23 6 * * *", "51 11 * * 1",
  "49 6,11,19 * * *", "24 6 * * 1", "17 13 * * *", "59 20 * * 0", "27 1 * * 1-5",
  "1 10 * * 1", "5 7 * * 1,4", "3 */2 * * *", "7 5 * * 1",
];

const cases = [
  // ── plain daily ──────────────────────────────────────────────────────────────────────
  { id: "daily · exactly at due", cron: "13 2 * * *", now: "2026-08-31T02:13:00Z", want: "2026-08-31T02:13Z" },
  { id: "daily · one minute before", cron: "13 2 * * *", now: "2026-08-31T02:12:00Z", want: "2026-08-30T02:13Z" },
  { id: "daily · one minute after", cron: "13 2 * * *", now: "2026-08-31T02:14:00Z", want: "2026-08-31T02:13Z" },
  { id: "daily · seconds are ignored", cron: "13 2 * * *", now: "2026-08-31T02:13:59Z", want: "2026-08-31T02:13Z" },
  { id: "daily · 6h late (the real case)", cron: "13 2 * * *", now: "2026-08-31T08:15:00Z", want: "2026-08-31T02:13Z" },

  // ── weekday-restricted · must not invent a weekend slot ──────────────────────────────
  { id: "weekdays · Monday at due", cron: "27 1 * * 1-5", now: "2026-08-31T01:27:00Z", want: "2026-08-31T01:27Z" },
  { id: "weekdays · Saturday falls back to Friday", cron: "27 1 * * 1-5", now: "2026-09-05T10:00:00Z", want: "2026-09-04T01:27Z" },
  { id: "weekdays · Sunday falls back to Friday", cron: "27 1 * * 1-5", now: "2026-09-06T10:00:00Z", want: "2026-09-04T01:27Z" },
  { id: "weekdays · Monday early falls back to Friday", cron: "27 1 * * 1-5", now: "2026-08-31T01:00:00Z", want: "2026-08-28T01:27Z" },

  // ── multi-day weekly ─────────────────────────────────────────────────────────────────
  { id: "Mon+Thu · Monday at due", cron: "5 7 * * 1,4", now: "2026-08-31T07:05:00Z", want: "2026-08-31T07:05Z" },
  { id: "Mon+Thu · Tuesday uses Monday", cron: "5 7 * * 1,4", now: "2026-09-01T12:00:00Z", want: "2026-08-31T07:05Z" },
  { id: "Mon+Thu · Thursday uses Thursday", cron: "5 7 * * 1,4", now: "2026-09-03T09:00:00Z", want: "2026-09-03T07:05Z" },
  { id: "Mon+Thu · Friday uses Thursday", cron: "5 7 * * 1,4", now: "2026-09-04T09:00:00Z", want: "2026-09-03T07:05Z" },

  // ── multi-hour list · three slots a day, not one ─────────────────────────────────────
  { id: "3x/day · first slot", cron: "49 6,11,19 * * *", now: "2026-08-31T06:49:00Z", want: "2026-08-31T06:49Z" },
  { id: "3x/day · between 1st and 2nd", cron: "49 6,11,19 * * *", now: "2026-08-31T10:00:00Z", want: "2026-08-31T06:49Z" },
  { id: "3x/day · second slot", cron: "49 6,11,19 * * *", now: "2026-08-31T11:49:00Z", want: "2026-08-31T11:49Z" },
  { id: "3x/day · third slot", cron: "49 6,11,19 * * *", now: "2026-08-31T19:50:00Z", want: "2026-08-31T19:49Z" },
  { id: "3x/day · after midnight uses yesterday 19:49", cron: "49 6,11,19 * * *", now: "2026-09-01T03:00:00Z", want: "2026-08-31T19:49Z" },

  // ── stepped hours · */2 is EVEN hours only ───────────────────────────────────────────
  { id: "every 2h · 04:07 exact", cron: "7 */2 * * *", now: "2026-08-31T04:07:00Z", want: "2026-08-31T04:07Z" },
  { id: "every 2h · 05:00 uses 04:07 (odd hour has no slot)", cron: "7 */2 * * *", now: "2026-08-31T05:00:00Z", want: "2026-08-31T04:07Z" },
  { id: "every 2h · 04:06 uses 02:07", cron: "7 */2 * * *", now: "2026-08-31T04:06:00Z", want: "2026-08-31T02:07Z" },
  { id: "every 2h · 00:07 is a slot", cron: "7 */2 * * *", now: "2026-08-31T00:07:00Z", want: "2026-08-31T00:07Z" },
  { id: "every 2h · 00:00 uses yesterday 22:07", cron: "7 */2 * * *", now: "2026-08-31T00:00:00Z", want: "2026-08-30T22:07Z" },
  { id: "every 6h · 06:11 exact", cron: "11 */6 * * *", now: "2026-08-31T06:11:00Z", want: "2026-08-31T06:11Z" },
  { id: "every 6h · 05:25 uses 00:11 (the 31 Aug double)", cron: "11 */6 * * *", now: "2026-08-31T05:25:00Z", want: "2026-08-31T00:11Z" },

  // ── monthly · day-of-month, and the slot can be 31 days back ─────────────────────────
  { id: "monthly · on the 1st at due", cron: "23 11 1 * *", now: "2026-09-01T11:23:00Z", want: "2026-09-01T11:23Z" },
  { id: "monthly · mid-month uses the 1st", cron: "23 11 1 * *", now: "2026-09-17T08:00:00Z", want: "2026-09-01T11:23Z" },
  { id: "monthly · 1st before due uses last month", cron: "23 11 1 * *", now: "2026-09-01T10:00:00Z", want: "2026-08-01T11:23Z" },
  { id: "monthly · 31-day month reaches back", cron: "4 9 1 * *", now: "2026-08-31T23:59:00Z", want: "2026-08-01T09:04Z" },

  // ── Sunday crons · dow=0 ─────────────────────────────────────────────────────────────
  { id: "Sunday · at due", cron: "56 8 * * 0", now: "2026-08-30T08:56:00Z", want: "2026-08-30T08:56Z" },
  { id: "Sunday · Monday uses Sunday", cron: "56 8 * * 0", now: "2026-08-31T14:00:00Z", want: "2026-08-30T08:56Z" },
  { id: "Sunday · Saturday uses last Sunday", cron: "56 8 * * 0", now: "2026-09-05T14:00:00Z", want: "2026-08-30T08:56Z" },

  // ── the >1-period-late case, stated explicitly ───────────────────────────────────────
  {
    id: "2h agent delivered 4h late → CURRENT period",
    cron: "7 */2 * * *", now: "2026-08-31T04:30:00Z", want: "2026-08-31T04:07Z",
    note: "documented behaviour: errs toward running, not skipping",
  },

  // ── month and year boundaries ────────────────────────────────────────────────────────
  { id: "crosses month boundary", cron: "13 2 * * *", now: "2026-09-01T01:00:00Z", want: "2026-08-31T02:13Z" },
  { id: "crosses year boundary", cron: "13 2 * * *", now: "2027-01-01T01:00:00Z", want: "2026-12-31T02:13Z" },

  // ── malformed input must be null, never a wrong slot ─────────────────────────────────
  { id: "malformed · four fields", cron: "13 2 * *", now: "2026-08-31T08:00:00Z", want: null },
  { id: "malformed · empty", cron: "", now: "2026-08-31T08:00:00Z", want: null },
  { id: "malformed · null", cron: null, now: "2026-08-31T08:00:00Z", want: null },
  { id: "malformed · six fields", cron: "0 13 2 * * *", now: "2026-08-31T08:00:00Z", want: null },
];

export function run() {
  const main = runCases("slot · most recent firing at or before now", cases, (c) => {
    const got = key(c.cron, c.now);
    return { ok: got === c.want, note: got === c.want ? (c.note || "") : `got ${got}, want ${c.want}` };
  });

  const field = runCases("slot · cron field matching", [
    { id: "star matches anything", v: 17, f: "*", want: true },
    { id: "exact match", v: 13, f: "13", want: true },
    { id: "exact non-match", v: 14, f: "13", want: false },
    { id: "list hit", v: 11, f: "6,11,19", want: true },
    { id: "list miss", v: 12, f: "6,11,19", want: false },
    { id: "range hit", v: 3, f: "1-5", want: true },
    { id: "range miss (weekend)", v: 6, f: "1-5", want: false },
    { id: "range edge low", v: 1, f: "1-5", want: true },
    { id: "range edge high", v: 5, f: "1-5", want: true },
    { id: "step hits even", v: 4, f: "*/2", want: true },
    { id: "step misses odd", v: 5, f: "*/2", want: false },
    { id: "step of 6 hits 18", v: 18, f: "*/6", want: true },
    { id: "step of 6 misses 17", v: 17, f: "*/6", want: false },
    { id: "zero matches every step", v: 0, f: "*/2", want: true },
    { id: "stepped range hit", v: 10, f: "0-20/5", want: true },
    { id: "stepped range miss", v: 11, f: "0-20/5", want: false },
    { id: "garbage field does not match", v: 3, f: "abc", want: false },
  ], (c) => {
    const got = matchField(c.v, c.f);
    return { ok: got === c.want, note: got === c.want ? "" : `got ${got}` };
  });

  // Sunday-as-7: GitHub accepts both. Nothing in the fleet uses 7, but a future edit might.
  const dow = runCases("slot · day-of-week conventions", [
    { id: "dow 0 is Sunday", cron: "0 0 * * 0", when: "2026-08-30T00:00:00Z", want: true },
    { id: "dow 7 is also Sunday", cron: "0 0 * * 7", when: "2026-08-30T00:00:00Z", want: true },
    { id: "dow 1 is Monday", cron: "0 0 * * 1", when: "2026-08-31T00:00:00Z", want: true },
    { id: "dow 1 is not Sunday", cron: "0 0 * * 1", when: "2026-08-30T00:00:00Z", want: false },
  ], (c) => {
    const got = cronHits(c.cron, at(c.when));
    return { ok: got === c.want, note: got === c.want ? "" : `got ${got}` };
  });

  // Every real cron must resolve, and the slot must genuinely be in the past and genuinely fire.
  const coverage = runCases("slot · every cron in the live fleet resolves", FLEET_CRONS.map((cron) => ({ id: cron, cron })), (c) => {
    const now = at("2026-09-15T13:37:00Z");
    const s = slotFor(c.cron, now);
    if (!s) return { ok: false, note: "no slot found in 32 days" };
    if (s > now) return { ok: false, note: `slot ${slotKey(s)} is in the FUTURE` };
    if (!cronHits(c.cron, s)) return { ok: false, note: `slot ${slotKey(s)} does not actually fire` };
    // Nothing may fire between the slot and now, or it is not the MOST RECENT one.
    for (let t = new Date(s.getTime() + 60000); t <= now; t = new Date(t.getTime() + 60000)) {
      if (cronHits(c.cron, t)) return { ok: false, note: `${slotKey(t)} is more recent than ${slotKey(s)}` };
    }
    return { ok: true, note: slotKey(s) };
  });

  const claim = runCases("slot · claim keys separate the crons of one workflow", [
    {
      id: "two crons of one workflow differ",
      ok: claimKey("Team Manager", "3 */2 * * *", at("2026-08-31T04:03:00Z"))
        !== claimKey("Team Manager", "7 5 * * 1", at("2026-08-31T04:03:00Z")),
    },
    {
      id: "same cron + slot is stable",
      ok: claimKey("Build Compass", "49 6,11,19 * * *", at("2026-08-31T06:49:00Z"))
        === claimKey("Build Compass", "49 6,11,19 * * *", at("2026-08-31T06:49:00Z")),
    },
    {
      id: "different slots differ",
      ok: claimKey("Calendar", "15 2 * * *", at("2026-08-31T02:15:00Z"))
        !== claimKey("Calendar", "15 2 * * *", at("2026-08-30T02:15:00Z")),
    },
    { id: "key is prefixed for pruning", ok: claimKey("X", "0 0 * * *", at("2026-08-31T00:00:00Z")).startsWith("gate:") },
  ], (c) => ({ ok: c.ok }));

  // run-all.mjs iterates over the returned blocks, so hand back the array, not an aggregate.
  return [main, field, dow, coverage, claim];
}

if (isMain(import.meta.url)) {
  const fail = run().reduce((n, r) => n + r.fail, 0);
  process.exit(fail ? 1 : 0);
}
