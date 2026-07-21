// evals/calendar/run.mjs
// Guards the Calendar agent's event handling (agents/33-calendar/calendar.js). Pure + offline.
//
// The all-day vs timed distinction is the classic bug here: Google returns `start.date` for all-day
// events and `start.dateTime` for timed ones, and treating them alike makes a birthday reminder
// look like a midnight meeting that blocks the entire day.
import "../_env.mjs";
import { runCases, isMain } from "../_lib.mjs";
import { parseEvent, normalizeEvents, summarizeDay, formatAgenda, explainError, describeVisibleCalendars, dayRange } from "../../agents/33-calendar/calendar.js";

const timed = (id, startIso, mins, extra = {}) => ({
  id, status: "confirmed", summary: `Event ${id}`,
  start: { dateTime: startIso }, end: { dateTime: new Date(new Date(startIso).getTime() + mins * 60000).toISOString() },
  ...extra,
});
const allDay = (id, date) => ({ id, status: "confirmed", summary: `AllDay ${id}`, start: { date }, end: { date } });

export function run() {
  const parsing = runCases("calendar · event parsing", [
    { id: "timed event parsed", check: () => parseEvent(timed("a", "2026-07-21T09:00:00Z", 30)).minutes === 30 },
    { id: "timed event not marked all-day", check: () => parseEvent(timed("a", "2026-07-21T09:00:00Z", 30)).allDay === false },
    { id: "all-day detected", check: () => parseEvent(allDay("b", "2026-07-21")).allDay === true },
    { id: "all-day contributes 0 minutes", check: () => parseEvent(allDay("b", "2026-07-21")).minutes === 0 },
    { id: "cancelled dropped", check: () => parseEvent({ ...timed("c", "2026-07-21T09:00:00Z", 30), status: "cancelled" }) === null },
    { id: "no start dropped", check: () => parseEvent({ id: "d", status: "confirmed" }) === null },
    { id: "null event safe", check: () => parseEvent(null) === null },
    { id: "missing title defaults", check: () => parseEvent({ status: "confirmed", start: { dateTime: "2026-07-21T09:00:00Z" } }).title === "(no title)" },
    { id: "self + resources excluded from attendee count", check: () => parseEvent(timed("e", "2026-07-21T09:00:00Z", 30, {
        attendees: [{ self: true }, { email: "a@b.c" }, { resource: true }, { email: "d@e.f" }] })).attendees === 2 },
    { id: "declined flagged", check: () => parseEvent(timed("f", "2026-07-21T09:00:00Z", 30, { attendees: [{ self: true, responseStatus: "declined" }] })).declined === true },
    { id: "long title truncated", check: () => parseEvent({ status: "confirmed", summary: "z".repeat(300), start: { dateTime: "2026-07-21T09:00:00Z" } }).title.length === 120 },
  ], (c) => ({ ok: c.check() }));

  const norm = runCases("calendar · normalisation", [
    { id: "sorted chronologically", check: () => normalizeEvents([timed("b", "2026-07-21T15:00:00Z", 30), timed("a", "2026-07-21T09:00:00Z", 30)])[0].id === "a" },
    { id: "declined events removed", check: () => normalizeEvents([timed("a", "2026-07-21T09:00:00Z", 30, { attendees: [{ self: true, responseStatus: "declined" }] })]).length === 0 },
    { id: "cancelled removed", check: () => normalizeEvents([{ ...timed("a", "2026-07-21T09:00:00Z", 30), status: "cancelled" }]).length === 0 },
    { id: "empty input safe", check: () => normalizeEvents([]).length === 0 },
    { id: "null input safe", check: () => normalizeEvents(null).length === 0 },
    { id: "junk entries skipped", check: () => normalizeEvents([null, {}, timed("a", "2026-07-21T09:00:00Z", 30)]).length === 1 },
  ], (c) => ({ ok: c.check() }));

  const NOW = new Date("2026-07-21T08:00:00Z");
  const dayEvents = normalizeEvents([timed("a", "2026-07-21T09:00:00Z", 60), timed("b", "2026-07-21T11:00:00Z", 30), allDay("c", "2026-07-21")]);
  const summary = runCases("calendar · day summary", [
    { id: "counts meetings excluding all-day", check: () => summarizeDay(dayEvents).meetings === 2 },
    { id: "counts all-day separately", check: () => summarizeDay(dayEvents).allDay === 1 },
    { id: "sums busy minutes", check: () => summarizeDay(dayEvents).busyMinutes === 90 },
    { id: "all-day never inflates busy time", check: () => summarizeDay(normalizeEvents([allDay("c", "2026-07-21")])).busyMinutes === 0 },
    { id: "OVERLAP counted once, not twice", check: () => summarizeDay(normalizeEvents([timed("a", "2026-07-21T09:00:00Z", 60), timed("b", "2026-07-21T09:30:00Z", 60)])).busyMinutes === 90 },
    { id: "fully nested meeting counted once", check: () => summarizeDay(normalizeEvents([timed("a", "2026-07-21T09:00:00Z", 120), timed("b", "2026-07-21T09:30:00Z", 30)])).busyMinutes === 120 },
    { id: "busyHours rounded to 1dp", check: () => summarizeDay(dayEvents).busyHours === 1.5 },
    { id: "next meeting from now", check: () => summarizeDay(dayEvents, { now: NOW }).next?.title === "Event a" },
    { id: "next skips past meetings", check: () => summarizeDay(dayEvents, { now: new Date("2026-07-21T10:00:00Z") }).next?.title === "Event b" },
    { id: "no next when day is done", check: () => summarizeDay(dayEvents, { now: new Date("2026-07-21T23:00:00Z") }).next === null },
    { id: "back-to-back detected", check: () => summarizeDay(normalizeEvents([timed("a", "2026-07-21T09:00:00Z", 60), timed("b", "2026-07-21T10:00:00Z", 30)])).backToBack === 1 },
    { id: "gap is not back-to-back", check: () => summarizeDay(normalizeEvents([timed("a", "2026-07-21T09:00:00Z", 60), timed("b", "2026-07-21T14:00:00Z", 30)])).backToBack === 0 },
    { id: "empty day safe", check: () => summarizeDay([]).meetings === 0 },
  ], (c) => ({ ok: c.check() }));

  const fmt = runCases("calendar · agenda formatting", [
    { id: "empty day says so", check: () => formatAgenda([], summarizeDay([])).includes("Nothing scheduled") },
    { id: "lists every event", check: () => { const s = formatAgenda(dayEvents, summarizeDay(dayEvents)); return s.includes("Event a") && s.includes("Event b") && s.includes("AllDay c"); } },
    { id: "all-day rendered as 'all day'", check: () => formatAgenda(dayEvents, summarizeDay(dayEvents)).includes("all day") },
    { id: "header pluralises correctly", check: () => formatAgenda(dayEvents, summarizeDay(dayEvents)).includes("2 meetings") },
    { id: "singular meeting", check: () => { const one = normalizeEvents([timed("a", "2026-07-21T09:00:00Z", 60)]); return formatAgenda(one, summarizeDay(one)).includes("1 meeting</b>") || formatAgenda(one, summarizeDay(one)).includes("1 meeting,"); } },
    { id: "warns on 2+ back-to-back", check: () => { const b = normalizeEvents([timed("a", "2026-07-21T09:00:00Z", 60), timed("b", "2026-07-21T10:00:00Z", 60), timed("c", "2026-07-21T11:00:00Z", 60)]); return formatAgenda(b, summarizeDay(b)).includes("back-to-back"); } },
    { id: "does not warn on one", check: () => { const b = normalizeEvents([timed("a", "2026-07-21T09:00:00Z", 60), timed("b", "2026-07-21T10:00:00Z", 60)]); return !formatAgenda(b, summarizeDay(b)).includes("back-to-back"); } },
    { id: "escaper is applied to titles", check: () => formatAgenda(normalizeEvents([timed("a", "2026-07-21T09:00:00Z", 30)]), summarizeDay([]), { esc: () => "XX" }).includes("XX") },
  ], (c) => ({ ok: c.check() }));

  // A service account has its own EMPTY calendar, so a sharing mistake looks exactly like a free
  // day. These messages are what stop that from being silently misread.
  const errs = runCases("calendar · setup errors are actionable", [
    { id: "404 explains sharing", check: () => /Share it with/.test(explainError(404, "me@x.com", "sa@p.iam")) },
    { id: "404 names the service account", check: () => explainError(404, "me@x.com", "sa@p.iam").includes("sa@p.iam") },
    { id: "403 mentions API + sharing", check: () => /Calendar API isn't enabled/.test(explainError(403, "me@x.com")) },
    { id: "401 points at the credentials", check: () => /GOOGLE_SA_JSON/.test(explainError(401, "me@x.com")) },
    { id: "unknown status still names the calendar", check: () => explainError(500, "me@x.com").includes("me@x.com") },
    // "not found" alone can't distinguish a bad id from a share that never applied — the probe must.
    { id: "no visible calendars -> says the share never landed", check: () => /NO calendars at all/.test(describeVisibleCalendars([])) },
    { id: "empty probe is still actionable", check: () => /Share with specific people/.test(describeVisibleCalendars(null)) },
    { id: "visible calendars are listed with their ids", check: () => describeVisibleCalendars([{ id: "a@b.c", accessRole: "reader" }]).includes("a@b.c") },
    { id: "shows the access role", check: () => describeVisibleCalendars([{ id: "a@b.c", accessRole: "reader" }]).includes("(reader)") },
    { id: "points at GOOGLE_CALENDAR_IDS when ids differ", check: () => describeVisibleCalendars([{ id: "a@b.c" }]).includes("GOOGLE_CALENDAR_IDS") },
    { id: "caps a long list at 10", check: () => (describeVisibleCalendars(Array.from({ length: 25 }, (_, i) => ({ id: `c${i}@x.y` }))).match(/•/g) || []).length === 10 },
  ], (c) => ({ ok: c.check() }));

  // The day window must be anchored to IST, not to whatever timezone the runner happens to use.
  // GitHub Actions runs in UTC, so a naive setHours(0,0,0,0) starts "today" at 05:30 IST and
  // silently drops every meeting scheduled between midnight and 05:29 IST.
  const tz = runCases("calendar · day window is IST, not the runner's timezone", [
    { id: "starts at 18:30Z (= 00:00 IST)", check: () => dayRange(new Date("2026-07-22T09:00:00Z")).start.toISOString() === "2026-07-21T18:30:00.000Z" },
    { id: "ends 24h later", check: () => dayRange(new Date("2026-07-22T09:00:00Z")).end.toISOString() === "2026-07-22T18:30:00.000Z" },
    { id: "labels the IST date", check: () => dayRange(new Date("2026-07-22T09:00:00Z")).date === "2026-07-22" },
    { id: "an 01:00 IST meeting IS inside today", check: () => {
        const { start, end } = dayRange(new Date("2026-07-22T09:00:00Z"));
        const meeting = new Date("2026-07-21T19:30:00Z").getTime();   // 01:00 IST on the 22nd
        return meeting >= start.getTime() && meeting < end.getTime();
      } },
    { id: "a 23:30 IST meeting is still today", check: () => {
        const { start, end } = dayRange(new Date("2026-07-22T09:00:00Z"));
        const meeting = new Date("2026-07-22T18:00:00Z").getTime();   // 23:30 IST on the 22nd
        return meeting >= start.getTime() && meeting < end.getTime();
      } },
    { id: "yesterday's 23:30 IST is NOT today", check: () => {
        const { start } = dayRange(new Date("2026-07-22T09:00:00Z"));
        return new Date("2026-07-21T18:00:00Z").getTime() < start.getTime();
      } },
    { id: "late-UTC run still resolves the right IST day", check: () => dayRange(new Date("2026-07-22T20:00:00Z")).date === "2026-07-23" },
    { id: "early-UTC run still resolves the right IST day", check: () => dayRange(new Date("2026-07-22T01:00:00Z")).date === "2026-07-22" },
    { id: "offsetDays walks forward", check: () => dayRange(new Date("2026-07-22T09:00:00Z"), { offsetDays: 1 }).date === "2026-07-23" },
    { id: "handles a month boundary", check: () => dayRange(new Date("2026-07-31T20:00:00Z")).date === "2026-08-01" },
  ], (c) => ({ ok: c.check() }));

  return [parsing, norm, summary, fmt, errs, tz];
}

if (isMain(import.meta.url)) {
  const results = run();
  if (results.some((r) => r.fail)) process.exit(1);
}
