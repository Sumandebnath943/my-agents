// agents/20-finance/digest.js  (pass "week" or "month" as arg; default = week)
// Summarizes debits over the period with Groq (private) and emails a category breakdown.
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { callLLM } from "../../lib/llm.js";
import { notifyEmail } from "../../lib/notify.js";
import { renderEmail, mdToHtml } from "../../lib/email-template.js";
import { sweep } from "../16-expenses/sweep.js";

const period = process.argv[2] === "month" ? 30 : 7;
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));
const since = new Date(Date.now() - period * 86400000).toISOString().slice(0, 10);

// Re-try receipt↔ledger matching before reporting. Runs BEFORE the early exit below so receipts
// still get reconciled in a quiet period. Best-effort: if sql/expenses_reconcile.sql hasn't been
// run this no-ops. Receipts never become transactions — this only links and fills blanks.
const rec = await sweep(db);
if (rec.error) console.error(`receipt reconciliation: ${rec.error} — has sql/expenses_reconcile.sql been run?`);
else console.log(`receipt reconciliation: checked ${rec.checked} — ${rec.counts.linked} linked, ${rec.counts.pending} still waiting, ${rec.counts.unmatched} unmatched, ${rec.counts.ambiguous} ambiguous.`);

const { data } = await db.from("finance").select("*").eq("direction", "debit").gte("spent_on", since);
if (!data?.length) { console.log("No debits in period."); process.exit(0); }

const total = data.reduce((s, r) => s + Number(r.amount || 0), 0);
const summary = await callLLM([
  { role: "system", content: "Group these debits into spend categories, give a total per category and overall, and flag anything unusual. Plain, brief." },
  { role: "user", content: JSON.stringify(data.map((d) => ({ merchant: d.merchant, amount: d.amount }))) },
]);

const byCat = {};
for (const r of data) byCat[r.category || "other"] = (byCat[r.category || "other"] || 0) + Number(r.amount || 0);
const inr = (n) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const catItems = Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, v]) => ({ title: c, note: inr(v) }));

await notifyEmail(`💸 Spend (${period}d): ₹${total.toFixed(0)}`, renderEmail({
  title: `Spend — last ${period} days`, kicker: "FINANCE", accent: "#0F6E56",
  blocks: [
    { type: "tiles", items: [
      { ramp: "teal", solid: true, span: "half", label: "Total spent", value: inr(total) },
      { ramp: "teal", span: "half", label: "Transactions", value: String(data.length) },
    ] },
    { type: "listSection", ramp: "teal", heading: "BY CATEGORY", items: catItems },
    { type: "text", html: mdToHtml(summary) },
  ],
  footer: "Finance · your SMS/notification ledger",
}));
console.log(`Digest sent: ₹${total.toFixed(0)} over ${period}d.`);
