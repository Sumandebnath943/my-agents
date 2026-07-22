// agents/17-habits/handle.js
// Handler for the inbox router: parse a freeform habit log into structured fields.
// e.g. "slept 2:30 woke 9 gym yes read no productivity 4"
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { callLLM, parseJson } from "../../lib/llm.js";
import { notifyTelegram } from "../../lib/notify.js";
import { sleepHours } from "./analyze.js";


const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));

// Strict trigger: "slept"/"woke"/"productivity" rarely appear in casual prose, so
// journal replies that merely mention "read" or "gym" won't be misrouted here.
// "mood" is included so `mood 4` alone routes here rather than being filed as a journal entry.
const HABIT_RE = /\bslept\b|\bwoke\b|\bproductivity\b|\bmood\b/i;
export function isHabitLog(text) { return HABIT_RE.test(text || ""); }

export async function handleHabit(msg) {
  const out = await callLLM(
    [
      { role: "system", content: 'Parse a daily habit log into JSON {"sleep_time":"HH:MM","wake_time":"HH:MM","exercised":true,"read_today":false,"productivity":1-5,"mood":1-5,"note":""}. Times are 24-hour. "mood" is how the person FELT (1 low, 5 great). Use null for anything not mentioned.' },
      { role: "user", content: msg.text },
    ],
    { json: true, chain: "private" } // Groq primary → OpenAI fallback; never free-tier providers
  );
  const h = parseJson(out);
  const log_date = new Date().toISOString().slice(0, 10);
  // One row per day: logging again (e.g. mood in the evening after sleep in the morning) should
  // TOP UP today's row, not create a second one that halves every average.
  const { data: existing } = await db.from("habits").select("id").eq("log_date", log_date).maybeSingle();
  const fields = Object.fromEntries(Object.entries(h).filter(([, v]) => v !== null && v !== undefined));
  if (existing?.id) await db.from("habits").update(fields).eq("id", existing.id);
  else await db.from("habits").insert({ log_date, ...fields });

  // Echo back what was understood — a silent "saved" hides a mis-parse until the charts look wrong.
  const hrs = sleepHours(h.sleep_time, h.wake_time);
  const bits = [
    hrs !== null ? `😴 ${hrs}h` : h.sleep_time || h.wake_time ? "😴 (times unclear)" : null,
    h.productivity != null ? `⚡ ${h.productivity}/5` : null,
    h.mood != null ? `🙂 mood ${h.mood}/5` : null,
    h.exercised ? "🏋️" : null,
    h.read_today ? "📖" : null,
  ].filter(Boolean);
  await notifyTelegram(`📊 <b>${existing?.id ? "Habit log updated" : "Habit log saved"}</b>${bits.length ? `\n${bits.join(" · ")}` : ""}`, { html: true });
  return true;
}
