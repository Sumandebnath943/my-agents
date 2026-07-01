// agents/17-habits/weekly.js — fortnightly pattern insight (email).
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { callGroq } from "../../lib/llm.js";
import { notifyEmail } from "../../lib/notify.js";
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));
const since = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
const { data } = await db.from("habits").select("*").gte("log_date", since);
if (!data || data.length < 3) process.exit(0);
const out = await callGroq([
  { role: "system", content: "Given 2 weeks of habit logs, find 1-2 honest patterns (e.g. relationship between sleep time and productivity), and one small experiment to try next week. Concrete, not preachy." },
  { role: "user", content: JSON.stringify(data) },
]);
await notifyEmail("📈 Your habit patterns this fortnight", `<pre>${out}</pre>`);
