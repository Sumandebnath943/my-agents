// agents/33-calendar/calendar.js
// Pure helpers for the Calendar agent — event shaping, day summarising, and agenda formatting.
// No network, no DB, so it can be unit-eval'd offline.
//
// Google returns two kinds of event times: `start.dateTime` (a timed event, with an offset) and
// `start.date` (an all-day event, a bare YYYY-MM-DD). Conflating them is the classic bug — an
// all-day event would otherwise look like it starts at midnight and blocks the whole day.

export const TZ = "Asia/Kolkata";
export const TZ_OFFSET_MIN = 330;   // IST = UTC+5:30, no DST

/**
 * The window covering one local (IST) day, as absolute instants.
 *
 * Do NOT use `new Date().setHours(0,0,0,0)` for this: that anchors to the RUNNER's timezone, and
 * GitHub Actions runs in UTC. "Today" would then start at 05:30 IST, so anything scheduled between
 * midnight and 05:29 IST would land in the previous UTC day and be silently dropped from the
 * agenda — the agent would confidently report a day that was missing its earliest meetings.
 * @param {number} offsetDays 0 = today, 1 = tomorrow
 */
export function dayRange(now = new Date(), { offsetDays = 0, offsetMin = TZ_OFFSET_MIN } = {}) {
  const shifted = new Date(now.getTime() + offsetMin * 60000);   // wall-clock time in the target zone
  const startMs = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + offsetDays) - offsetMin * 60000;
  const start = new Date(startMs);
  return { start, end: new Date(startMs + 86400000), date: new Date(startMs + offsetMin * 60000).toISOString().slice(0, 10) };
}

const fmtTime = (iso, tz = TZ) => {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: tz }).replace(/\s?([ap])\.?m\.?/i, (m, p) => p.toLowerCase() + "m");
};

/** Normalise one Google event. Returns null for events that shouldn't be shown. */
export function parseEvent(ev) {
  if (!ev || ev.status === "cancelled") return null;
  const allDay = !!ev.start?.date && !ev.start?.dateTime;
  const startRaw = ev.start?.dateTime || ev.start?.date || null;
  const endRaw = ev.end?.dateTime || ev.end?.date || null;
  if (!startRaw) return null;

  const startMs = new Date(allDay ? `${startRaw}T00:00:00Z` : startRaw).getTime();
  const endMs = endRaw ? new Date(allDay ? `${endRaw}T00:00:00Z` : endRaw).getTime() : startMs;
  if (!Number.isFinite(startMs)) return null;

  // Only real, invited humans count as attendees — Google lists the calendar owner too.
  const attendees = (Array.isArray(ev.attendees) ? ev.attendees : [])
    .filter((a) => a && !a.self && !a.resource).length;

  return {
    id: ev.id || null,
    title: String(ev.summary || "(no title)").slice(0, 120),
    allDay,
    start: startRaw,
    startMs,
    endMs: Number.isFinite(endMs) ? endMs : startMs,
    minutes: allDay ? 0 : Math.max(0, Math.round(((Number.isFinite(endMs) ? endMs : startMs) - startMs) / 60000)),
    attendees,
    location: ev.location ? String(ev.location).slice(0, 80) : null,
    link: ev.hangoutLink || null,
    declined: (Array.isArray(ev.attendees) ? ev.attendees : []).some((a) => a?.self && a.responseStatus === "declined"),
  };
}

/** Parse + drop declined events + sort chronologically. */
export function normalizeEvents(items) {
  return (Array.isArray(items) ? items : [])
    .map(parseEvent)
    .filter((e) => e && !e.declined)
    .sort((a, b) => a.startMs - b.startMs || (a.title > b.title ? 1 : -1));
}

/**
 * Summarise a day so other agents can reason about load without re-reading Google.
 * `busyMinutes` counts MERGED intervals — two overlapping meetings are one busy block, not two.
 */
export function summarizeDay(events, { now = new Date() } = {}) {
  const evs = (events || []).filter((e) => !e.allDay);
  const merged = [];
  for (const e of [...evs].sort((a, b) => a.startMs - b.startMs)) {
    const last = merged[merged.length - 1];
    if (last && e.startMs <= last.end) last.end = Math.max(last.end, e.endMs);
    else merged.push({ start: e.startMs, end: e.endMs });
  }
  const busyMinutes = merged.reduce((s, b) => s + Math.max(0, Math.round((b.end - b.start) / 60000)), 0);
  const nowMs = now.getTime();
  const next = evs.find((e) => e.startMs >= nowMs) || null;

  // Back-to-back = a meeting starting within 5 minutes of the previous one ending.
  let backToBack = 0;
  const sorted = [...evs].sort((a, b) => a.startMs - b.startMs);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].startMs - sorted[i - 1].endMs <= 5 * 60000) backToBack++;

  return {
    total: (events || []).length,
    meetings: evs.length,
    allDay: (events || []).filter((e) => e.allDay).length,
    busyMinutes,
    busyHours: Math.round((busyMinutes / 60) * 10) / 10,
    backToBack,
    firstStart: sorted[0]?.start || null,
    next: next ? { title: next.title, start: next.start } : null,
  };
}

/** Telegram-ready agenda. `esc` is injected so this stays dependency-free and testable. */
export function formatAgenda(events, summary, { esc = (s) => String(s), tz = TZ } = {}) {
  if (!events?.length) return "📅 <b>Today</b>\nNothing scheduled — the day is yours.";
  const lines = events.map((e) => {
    const when = e.allDay ? "all day" : `${fmtTime(e.start, tz)}${e.minutes ? ` · ${e.minutes}m` : ""}`;
    const who = e.attendees ? ` · 👥 ${e.attendees}` : "";
    const where = e.link ? " · 🎥" : e.location ? ` · 📍 ${esc(e.location)}` : "";
    return `• <b>${esc(e.title)}</b>\n   <i>${when}${who}${where}</i>`;
  });
  const head = `📅 <b>Today — ${summary.meetings} meeting${summary.meetings === 1 ? "" : "s"}${summary.busyHours ? `, ${summary.busyHours}h booked` : ""}</b>`;
  const warn = summary.backToBack >= 2 ? `\n\n⚠️ ${summary.backToBack} back-to-back — build in a gap.` : "";
  return `${head}\n\n${lines.join("\n")}${warn}`;
}

/**
 * Turn a Google API failure into something actionable. A service account has its OWN empty
 * calendar, so the overwhelmingly likely cause of 403/404 is that the calendar was never SHARED
 * with it — which would otherwise look exactly like "you have no meetings today".
 */
export function explainError(status, calendarId, saEmail = "the service account") {
  if (status === 404) return `Calendar "${calendarId}" not found. Share it with ${saEmail} (Google Calendar → Settings → Share with specific people → See all event details).`;
  if (status === 403) return `Access denied for "${calendarId}". Either the Calendar API isn't enabled in the Google Cloud project, or the calendar isn't shared with ${saEmail}.`;
  if (status === 401) return "Google rejected the service-account credentials (GOOGLE_SA_JSON).";
  return `Google Calendar API returned ${status} for "${calendarId}".`;
}
