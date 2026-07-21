// agents/33-calendar/index.js — the fleet's time-awareness.
//
// Until now nothing in Migi knew whether Suman was free or in meetings all day. This reads the
// calendar each morning, sends the agenda, and — importantly — parks a compact summary in kv
// (`calendar:today`, `calendar:week`) so OTHER agents can reason about load without needing Google
// credentials of their own. The Weekly Review reads `calendar:week` for its focus areas.
//
// Reuses lib/google-auth.js — the same service-account JWT already used for Search Console and
// GA4. All three APIs are free.
//
// SETUP (one-time, and the agent tells you if it's missing): a service account has its own empty
// calendar, so Suman's calendar must be SHARED with the SA's client_email, and the Calendar API
// enabled in the Cloud project. Without that, Google answers 404/403 — which looks identical to
// "no meetings today", so this agent treats it as a hard, loud failure rather than a quiet day.
import { env } from "../../lib/env.js";
import { googleToken } from "../../lib/google-auth.js";
import { getState, setState } from "../../lib/store.js";
import { notifyTelegram, tgEscape } from "../../lib/notify.js";
import { normalizeEvents, summarizeDay, formatAgenda, explainError, describeVisibleCalendars, dayRange, TZ } from "./calendar.js";

const CAL_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
// Which calendars to read. A service account's own "primary" is empty, so this must be the
// calendar's real id — normally the owner's email address.
const CALENDAR_IDS = (process.env.GOOGLE_CALENDAR_IDS || process.env.MY_EMAIL || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

if (!CALENDAR_IDS.length) {
  console.error("calendar: no calendar configured — set GOOGLE_CALENDAR_IDS (or MY_EMAIL).");
  process.exit(1);
}

const saEmail = (() => { try { return JSON.parse(env("GOOGLE_SA_JSON")).client_email; } catch { return "the service account"; } })();
const token = await googleToken(CAL_SCOPE);
if (!token) { console.error("calendar: could not mint a Google access token from GOOGLE_SA_JSON."); process.exit(1); }

// "Today" must mean today in IST, not on the UTC runner — see dayRange().
const { start: dayStart, end: dayEnd, date: todayDate } = dayRange();
const weekEnd = new Date(dayStart.getTime() + 7 * 86400000);

async function fetchEvents(calendarId, timeMin, timeMax) {
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("timeMin", timeMin.toISOString());
  url.searchParams.set("timeMax", timeMax.toISOString());
  url.searchParams.set("singleEvents", "true");     // expand recurring series into real instances
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", "50");
  url.searchParams.set("timeZone", TZ);
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(explainError(r.status, calendarId, saEmail));
  return (await r.json()).items || [];
}

let weekRaw = [];
const failures = [];
for (const id of CALENDAR_IDS) {
  try { weekRaw.push(...(await fetchEvents(id, dayStart, weekEnd))); }
  catch (e) { failures.push(e.message); }
}

// EVERY calendar failed → this is a setup/permissions problem, not an empty week. Say so loudly;
// silently reporting "nothing scheduled" is exactly the false-success this fleet keeps eliminating.
// And don't just report the failure — probe what the service account CAN see, so the message
// diagnoses the cause instead of leaving it to another round of guessing.
if (failures.length === CALENDAR_IDS.length) {
  let diagnosis = "";
  try {
    const r = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=20", { headers: { Authorization: `Bearer ${token}` } });
    diagnosis = r.ok
      ? describeVisibleCalendars((await r.json()).items)
      : `Couldn't list the service account's calendars either (${r.status}) — if that's 403, enable the Google Calendar API in the "${saEmail.split("@")[1]?.split(".")[0] || "same"}" Cloud project.`;
  } catch (e) { diagnosis = `Diagnostic probe failed: ${e.message}`; }

  await notifyTelegram(`📅 <b>Calendar unavailable</b>\n${tgEscape(failures[0])}\n\n<b>Diagnosis</b>\n${tgEscape(diagnosis)}`, { html: true });
  console.error("calendar: all calendars failed —", failures.join(" | "), "|", diagnosis);
  process.exit(1);
}
if (failures.length) console.error("calendar: some calendars failed —", failures.join(" | "));

const week = normalizeEvents(weekRaw);
const today = week.filter((e) => e.startMs < dayEnd.getTime() && e.endMs >= dayStart.getTime());
const todaySummary = summarizeDay(today);
const weekSummary = summarizeDay(week);

// Park compact summaries for the rest of the fleet (no Google creds needed downstream).
const upcoming = week.slice(0, 20).map((e) => ({ title: e.title, start: e.start, allDay: e.allDay, minutes: e.minutes, attendees: e.attendees }));
try {
  await setState("calendar:today", { date: todayDate, ...todaySummary, events: today.map((e) => ({ title: e.title, start: e.start, allDay: e.allDay, minutes: e.minutes })) });
  await setState("calendar:week", { generated_at: new Date().toISOString(), meetings: weekSummary.meetings, busyHours: weekSummary.busyHours, events: upcoming });
} catch (e) { console.error("calendar: couldn't park the summary in kv:", e.message); }

// Only ping when the day actually has something in it — a silent morning means a free day.
const DIGEST = process.env.DIGEST === "1";
if (!today.length && !DIGEST) {
  console.log("calendar: nothing scheduled today; staying quiet.");
  process.exit(0);
}

// Mention tomorrow's first item so an early start isn't a surprise.
const tomorrow = week.filter((e) => e.startMs >= dayEnd.getTime() && e.startMs < dayEnd.getTime() + 86400000);
const tomorrowNote = tomorrow.length ? `\n\n<i>Tomorrow: ${tomorrow.length} item(s), first at ${tgEscape(new Date(tomorrow[0].start).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: TZ }))}</i>` : "";

await notifyTelegram(formatAgenda(today, todaySummary, { esc: tgEscape }) + tomorrowNote, { html: true });
console.log(`calendar: ${today.length} event(s) today, ${todaySummary.busyHours}h booked; ${week.length} in the next 7d.`);
