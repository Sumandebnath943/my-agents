// agents/16-expenses/weekly.js — weekly spend summary as a bento email.
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { notifyEmail } from "../../lib/notify.js";
import { renderEmail } from "../../lib/email-template.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));
const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
const { data } = await db.from("expenses").select("*").gte("spent_on", since);
if (!data?.length) process.exit(0);

const CAT = {
  food:      { emoji: "🍔", ramp: "coral",  label: "Food" },
  transport: { emoji: "🚕", ramp: "blue",   label: "Transport" },
  shopping:  { emoji: "🛍️", ramp: "purple", label: "Shopping" },
  bills:     { emoji: "🧾", ramp: "amber",  label: "Bills" },
  other:     { emoji: "💳", ramp: "gray",   label: "Other" },
};

const byCat = {};
let total = 0;
let biggest = { merchant: "—", amount: 0 };
for (const e of data) {
  const amt = Number(e.amount) || 0;
  const cat = (e.category || "other").toLowerCase();
  byCat[cat] = (byCat[cat] || 0) + amt;
  total += amt;
  if (amt > biggest.amount) biggest = { merchant: e.merchant || "—", amount: amt };
}
const currency = data[0].currency || "INR";
const money = (n) => `${currency} ${Math.round(n).toLocaleString("en-IN")}`;

const catTiles = Object.entries(byCat)
  .sort((a, b) => b[1] - a[1])
  .map(([cat, amt]) => {
    const c = CAT[cat] || CAT.other;
    return { ramp: c.ramp, emoji: c.emoji, label: c.label, value: money(amt) };
  });

const tiles = [
  { ramp: "teal", solid: true, span: "full", label: "TOTAL THIS WEEK", value: money(total), sub: `across ${data.length} transaction${data.length > 1 ? "s" : ""}` },
  ...catTiles,
  { ramp: "green", span: "half", emoji: "🏆", label: "Biggest", value: money(biggest.amount), sub: biggest.merchant },
];

const html = renderEmail({
  title: "🧾 Your Weekly Spend",
  kicker: `WEEK ENDING ${new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`,
  accent: "#0F6E56",
  blocks: [{ type: "tiles", items: tiles }],
  footer: "Logged from your receipt photos this week",
});
await notifyEmail(`🧾 This week's spend: ${money(total)}`, html);
console.log("expenses weekly sent:", money(total));
