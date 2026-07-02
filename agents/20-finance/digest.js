// agents/20-finance/digest.js  (pass "week" or "month" as arg; default = week)
// Summarizes debits over the period with Groq (private) and emails a category breakdown.
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { callGroq } from "../../lib/llm.js";
import { notifyEmail } from "../../lib/notify.js";

const period = process.argv[2] === "month" ? 30 : 7;
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));
const since = new Date(Date.now() - period * 86400000).toISOString().slice(0, 10);

const { data } = await db.from("finance").select("*").eq("direction", "debit").gte("spent_on", since);
if (!data?.length) { console.log("No debits in period."); process.exit(0); }

const total = data.reduce((s, r) => s + Number(r.amount || 0), 0);
const summary = await callGroq([
  { role: "system", content: "Group these debits into spend categories, give a total per category and overall, and flag anything unusual. Plain, brief." },
  { role: "user", content: JSON.stringify(data.map((d) => ({ merchant: d.merchant, amount: d.amount }))) },
]);

await notifyEmail(
  `💸 Spend (${period}d): ₹${total.toFixed(0)}`,
  `<h3 style="font-family:system-ui,sans-serif">Spend — last ${period} days</h3>
   <p style="font-family:system-ui,sans-serif">Total debits: <b>₹${total.toFixed(0)}</b> across ${data.length} transactions.</p>
   <pre style="white-space:pre-wrap;font-family:ui-monospace,monospace;background:#f6f6f4;padding:14px;border-radius:10px">${String(summary).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`
);
console.log(`Digest sent: ₹${total.toFixed(0)} over ${period}d.`);
