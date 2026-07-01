// agents/17-habits/handle.js
// Handler for the inbox router: parse a freeform habit log into structured fields.
// e.g. "slept 2:30 woke 9 gym yes read no productivity 4"
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { callGroq, parseJson } from "../../lib/llm.js";
import { notifyTelegram } from "../../lib/notify.js";


const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));

// Strict trigger: "slept"/"woke"/"productivity" rarely appear in casual prose, so
// journal replies that merely mention "read" or "gym" won't be misrouted here.
const HABIT_RE = /\bslept\b|\bwoke\b|\bproductivity\b/i;
export function isHabitLog(text) { return HABIT_RE.test(text || ""); }

export async function handleHabit(msg) {
  const out = await callGroq(
    [
      { role: "system", content: 'Parse a daily habit log into JSON {"sleep_time":"HH:MM","wake_time":"HH:MM","exercised":true,"read_today":false,"productivity":1-5,"note":""}. Use null for anything not mentioned.' },
      { role: "user", content: msg.text },
    ],
    { json: true }
  );
  const h = parseJson(out);
  await db.from("habits").insert({ log_date: new Date().toISOString().slice(0, 10), ...h });
  await notifyTelegram(`📊 <b>Habit log saved</b>`, { html: true });
  return true;
}
