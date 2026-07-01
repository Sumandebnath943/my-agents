// agents/17-habits/weekly.js — fortnightly pattern insight, with metric tiles (email).
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { callGroq } from "../../lib/llm.js";
import { notifyEmail } from "../../lib/notify.js";
import { renderEmail } from "../../lib/email-template.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));
const since = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
const { data } = await db.from("habits").select("*").gte("log_date", since);
if (!data || data.length < 3) process.exit(0);

const gymDays = data.filter((h) => h.exercised).length;
const readDays = data.filter((h) => h.read_today).length;
const prods = data.map((h) => Number(h.productivity)).filter((n) => Number.isFinite(n));
const avgProd = prods.length ? (prods.reduce((a, b) => a + b, 0) / prods.length).toFixed(1) : "—";

const out = await callGroq([
  { role: "system", content: "Given 2 weeks of habit logs, find 1-2 honest patterns (e.g. relationship between sleep time and productivity), and one small experiment to try next week. Concrete, not preachy." },
  { role: "user", content: JSON.stringify(data) },
]);
const body = out.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");

const html = renderEmail({
  title: "📈 Your Habit Patterns",
  kicker: "LAST 2 WEEKS",
  accent: "#639922",
  blocks: [
    { type: "tiles", items: [
      { ramp: "green",  emoji: "🗓️", label: "Days logged",      value: String(data.length) },
      { ramp: "blue",   emoji: "🏋️", label: "Workouts",         value: String(gymDays) },
      { ramp: "amber",  emoji: "⚡",  label: "Avg productivity", value: `${avgProd}/5` },
      { ramp: "purple", emoji: "📖", label: "Read days",        value: String(readDays) },
    ]},
    { type: "text", html: body },
  ],
  footer: "Logged via your Telegram bot",
});
await notifyEmail("📈 Your habit patterns this fortnight", html);
console.log("habits weekly sent:", data.length);
