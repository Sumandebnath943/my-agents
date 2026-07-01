// agents/16-expenses/weekly.js — weekly spend summary by category (email).
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { notifyEmail } from "../../lib/notify.js";
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));
const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
const { data } = await db.from("expenses").select("*").gte("spent_on", since);
if (!data?.length) process.exit(0);
const byCat = {};
let total = 0;
for (const e of data) { byCat[e.category] = (byCat[e.category] || 0) + Number(e.amount); total += Number(e.amount); }
const rows = Object.entries(byCat).sort((a,b)=>b[1]-a[1]).map(([c,v]) => `<li>${c}: ${v.toFixed(2)}</li>`).join("");
await notifyEmail(`🧾 This week's spend: ${total.toFixed(2)}`, `<ul>${rows}</ul><p>${data.length} transactions.</p>`);
