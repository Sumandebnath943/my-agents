// agents/15-journal/weekly.js — query last 7 days, ask Groq for patterns, email it.
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { callGroq } from "../../lib/llm.js";
import { notifyEmail } from "../../lib/notify.js";
import { renderEmail } from "../../lib/email-template.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));
const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
const { data } = await db.from("journal").select("*").gte("entry_date", since);
if (!data?.length) process.exit(0);

const out = await callGroq([
  { role: "system", content: "Given a week of journal entries, reflect gently: recurring themes, mood arc, and one supportive observation. No clinical language." },
  { role: "user", content: JSON.stringify(data.map((d) => ({ date: d.entry_date, mood: d.mood, themes: d.themes, summary: d.summary }))) },
]);

const body = out.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
const html = renderEmail({
  title: "🪞 Your Week in Reflection",
  kicker: "WEEKLY",
  accent: "#4A3F9E",
  blocks: [
    { type: "stat", text: `📝 ${data.length} entr${data.length > 1 ? "ies" : "y"} this week` },
    { type: "text", html: body },
  ],
  footer: "Journaled via your Telegram bot · kept private on Groq",
});
await notifyEmail("🪞 Your week in reflection", html);
console.log("journal weekly sent:", data.length);
