// agents/17-habits/checkin.js — the daily nudges that keep the health data flowing.
//
// MODE=morning (07:00 IST): asks how you slept, but ONLY if today's sleep isn't already logged.
// MODE=evening (21:30 IST): asks for productivity/mood, ONLY if today's row is still missing them.
//
// The "only if" is the whole design. A reminder that fires after you've already logged trains you
// to ignore the channel, and an ignored nudge collects no data — which is the one thing this
// agent exists to do. Nothing to log = nothing sent.
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { notifyTelegram } from "../../lib/notify.js";
import { sleepHours, streak, summary } from "./analyze.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));
const MODE = process.env.MODE === "evening" ? "evening" : "morning";
const today = new Date().toISOString().slice(0, 10);

const { data: row } = await db.from("habits").select("*").eq("log_date", today).maybeSingle();
const hasSleep = !!(row && sleepHours(row.sleep_time, row.wake_time) !== null);
const hasDay = !!(row && row.productivity != null && row.mood != null);

if (MODE === "morning" && hasSleep) { console.log("checkin: sleep already logged today; staying quiet."); process.exit(0); }
if (MODE === "evening" && hasDay) { console.log("checkin: day already logged; staying quiet."); process.exit(0); }

// A little context makes the nudge worth reading rather than just another ping.
const since = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
const { data: recent } = await db.from("habits").select("*").gte("log_date", since);
const s = summary(recent || []);
const run = streak(recent || []);

let text;
if (MODE === "morning") {
  const ctx = s.avg_sleep ? `\n<i>14-day average: ${s.avg_sleep}h</i>` : "";
  text = `☀️ <b>Morning — how did you sleep?</b>\nReply like: <code>slept 23:30 woke 7</code>${ctx}`;
} else {
  const missing = [];
  if (!row || row.productivity == null) missing.push("productivity");
  if (!row || row.mood == null) missing.push("mood");
  const ctx = run > 1 ? `\n<i>🔥 ${run}-day logging streak — don't break it.</i>` : "";
  text = `🌙 <b>Evening check-in</b>\nHow was today? Missing: ${missing.join(" + ")}.\nReply like: <code>productivity 4 mood 3</code>${ctx}`;
}

await notifyTelegram(text, { html: true });
console.log(`checkin: ${MODE} nudge sent (streak ${run}).`);
