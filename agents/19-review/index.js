// agents/19-review/index.js
// The capstone: reads the data every other agent has collected this week and writes
// one "state of you" review. The more agents feeding tables, the richer this gets.
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { getState } from "../../lib/store.js";
import { callGemini } from "../../lib/llm.js";
import { notifyEmail } from "../../lib/notify.js";
import { renderEmail } from "../../lib/email-template.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));
const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

async function rows(table, dateCol) {
  try {
    const { data } = await db.from(table).select("*").gte(dateCol, weekAgo);
    return data || [];
  } catch { return []; }
}

const [journal, expenses, habits, reading, ideas] = await Promise.all([
  rows("journal", "entry_date"),
  rows("expenses", "spent_on"),
  rows("habits", "log_date"),
  rows("reading", "created_at"),
  (async () => (await db.from("ideas").select("*").order("score", { ascending: false }).limit(3)).data || [])(),
]);
const linkedinQueue = (await getState("linkedin:queue", [])) || [];
const postsThisWeek = linkedinQueue.filter((q) => q.status === "posted").length;

if (!journal.length && !expenses.length && !habits.length && !reading.length && !ideas.length) {
  console.log("No data this week; skipping review.");
  process.exit(0);
}

const spendTotal = expenses.reduce((s, e) => s + Number(e.amount || 0), 0);
const cur = expenses[0]?.currency || "INR";
const prods = habits.map((h) => Number(h.productivity)).filter(Number.isFinite);
const avgProd = prods.length ? (prods.reduce((a, b) => a + b, 0) / prods.length).toFixed(1) : "—";

const dossier = {
  journal: journal.map((j) => ({ date: j.entry_date, mood: j.mood, themes: j.themes })),
  spend_total: spendTotal,
  spend_count: expenses.length,
  habits: habits.map((h) => ({ date: h.log_date, sleep: h.sleep_time, productivity: h.productivity })),
  articles_saved: reading.length,
  linkedin_posts: postsThisWeek,
  top_ideas: ideas.map((i) => i.title),
};

const report = await callGemini(
  `You are my weekly chief-of-staff. Using this week's data, write a warm but honest
"state of you" review: (1) a 3-line summary of how the week went, (2) notable trends
across work, mood, habits, and spending, (3) exactly three focus areas for next week.
Be specific to the data; don't invent. End by nudging me to build my top idea.

Data: ${JSON.stringify(dossier, null, 2)}`
);
const body = report.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");

const tiles = [
  { ramp: "indigo", emoji: "📓", label: "Journal", value: String(journal.length), sub: "entries" },
  { ramp: "pink",   emoji: "📚", label: "Saved",   value: String(reading.length), sub: "articles" },
  { ramp: "teal",   emoji: "💸", label: "Spend",   value: `${cur} ${Math.round(spendTotal).toLocaleString("en-IN")}`, sub: `${expenses.length} txns` },
  { ramp: "amber",  emoji: "⚡", label: "Avg productivity", value: `${avgProd}/5`, sub: `${habits.length} logs` },
];
if (ideas[0]) tiles.push({ ramp: "green", span: "full", emoji: "💡", label: "Top idea to build", value: ideas[0].title });

const html = renderEmail({
  title: "🧭 Weekly Founder Review",
  kicker: "STATE OF YOU",
  accent: "#2C3E50",
  blocks: [{ type: "tiles", items: tiles }, { type: "divider" }, { type: "text", html: body }],
  footer: "Orchestrated from journal · expenses · habits · reading · ideas",
});
await notifyEmail("🧭 Your Weekly Founder Review", html);
console.log(report);
