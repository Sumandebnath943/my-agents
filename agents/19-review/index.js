// agents/19-review/index.js
// The capstone: reads the data every other agent has collected this week and writes
// one "state of you" review. The more agents feeding tables, the richer this gets.
//
// Reads the WHOLE fleet, not just the Round-1 tables: personal ops (journal/habits/reading/ideas),
// money (finance — the SMS bank ledger), career (jobs/skills/outreach), building
// (build_projects/launches/ideas), brand (linkedin_posts/brand_snapshots) and engineering
// (code_reviews). Aggregation lives in ./dossier.js so it can be eval'd offline.
//
// Every read is best-effort: a table that doesn't exist yet simply contributes nothing.
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { callLLM } from "../../lib/llm.js";
import { notifyEmail } from "../../lib/notify.js";
import { renderEmail } from "../../lib/email-template.js";
import { buildDossier, hasAnyData } from "./dossier.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));
const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

// One best-effort read. Supabase RESOLVES with { error } instead of rejecting, so the `|| []`
// matters as much as the try/catch — without both, a missing table would surface as null.
async function q(fn) {
  try { return (await fn()) || []; } catch { return []; }
}
const since = (table, dateCol) => q(async () => (await db.from(table).select("*").gte(dateCol, weekAgo)).data);

const [journal, expenses, finance, habits, reading, ideas, jobs, skills, builds, opportunities,
       launches, posts, reviews, brand, resumes] = await Promise.all([
  since("journal", "entry_date"),
  since("expenses", "spent_on"),
  since("finance", "spent_on"),
  since("habits", "log_date"),
  since("reading", "created_at"),
  q(async () => (await db.from("ideas").select("*").order("score", { ascending: false }).limit(3)).data),
  since("jobs", "created_at"),
  // Skills + build candidates are STATE, not weekly events — show what's currently on the plate.
  q(async () => (await db.from("skills").select("skill,status").in("status", ["open", "learning"]).limit(20)).data),
  q(async () => (await db.from("build_projects").select("pick,score,status").neq("status", "expired").order("score", { ascending: false }).limit(5)).data),
  since("opportunities", "created_at"),
  since("launches", "created_at"),
  since("linkedin_posts", "created_at"),
  since("code_reviews", "created_at"),
  // 24 rows = enough to hold this week AND last week per property, for regression detection.
  q(async () => (await db.from("brand_snapshots").select("name,week,perf,seo,broken_links").order("week", { ascending: false }).limit(24)).data),
  q(async () => (await db.from("resume_reports").select("score,score_out_of,created_at").order("created_at", { ascending: false }).limit(1)).data),
]);

// Next week's load, parked in kv by the Calendar agent (#33) so this doesn't need Google creds.
// Absent until that agent runs — the review simply won't mention the calendar.
const calendar = await q(async () => (await db.from("kv").select("value").eq("key", "calendar:week").maybeSingle()).data?.value);

const dossier = buildDossier({ journal, expenses, finance, habits, reading, ideas, jobs, skills,
  builds, opportunities, launches, posts, reviews, brand, resumes, calendar });

if (!hasAnyData(dossier)) {
  console.log("No data anywhere this week; skipping review.");
  process.exit(0);
}

const report = await callLLM(
  `You are my weekly chief-of-staff. Using this week's data across my whole system, write a warm but
honest "state of you" review: (1) a 3-line summary of how the week went, (2) notable trends and any
connections BETWEEN areas (e.g. spending vs mood, job-match quality vs the skills I'm learning,
shipping velocity vs code-review findings), (3) exactly three focus areas for next week.
Be specific to the data and don't invent. Sections that are empty or zero simply mean I didn't do
that this week — mention them only if the absence is itself worth noting. End by nudging me on the
single highest-leverage thing: my top idea, my best-fit role, or my most urgent code/brand issue.

Data: ${JSON.stringify(dossier, null, 2)}`
);
const body = report.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");

const { spend, habits: hb, jobs: jb, code, brand: br, linkedin } = dossier;
const money = (n) => `${spend.currency} ${Math.round(n).toLocaleString("en-IN")}`;

// Two clean rows of three tiles. Only the spend tile is unconditional; the rest appear when there
// is something to say, so a quiet week still renders a tidy grid instead of a wall of zeros.
const tiles = [
  { ramp: "teal", emoji: "💸", label: "Spend (bank ledger)", value: money(spend.total), sub: `${spend.txns} debits` },
  { ramp: "amber", emoji: "⚡", label: "Avg productivity", value: hb.avg_productivity != null ? `${hb.avg_productivity}/5` : "—", sub: `${hb.logs} logs` },
  { ramp: "indigo", emoji: "📓", label: "Journal", value: String(dossier.journal.entries), sub: "entries" },
];
if (jb.new_roles) tiles.push({ ramp: "blue", emoji: "💼", label: "New roles", value: String(jb.new_roles), sub: jb.avg_fit != null ? `avg fit ${jb.avg_fit}%` : "scored" });
if (linkedin.posted || linkedin.awaiting) tiles.push({ ramp: "pink", emoji: "✍️", label: "LinkedIn", value: String(linkedin.posted), sub: linkedin.awaiting ? `${linkedin.awaiting} awaiting` : "posted" });
if (code.reviews) tiles.push({ ramp: code.high ? "red" : "green", emoji: "🤖", label: "Code issues", value: String(code.issues), sub: `${code.reviews} reviews${code.high ? ` · ${code.high} high` : ""}` });
if (dossier.reading.saved) tiles.push({ ramp: "purple", emoji: "📚", label: "Saved", value: String(dossier.reading.saved), sub: `${dossier.reading.unread} unread` });
if (br.sites) tiles.push({ ramp: br.regressions.length ? "coral" : "green", emoji: "🌐", label: "Brand perf", value: br.avg_perf != null ? String(br.avg_perf) : "—", sub: `${br.sites} sites` });
if (dossier.ideas[0]) tiles.push({ ramp: "green", span: "full", emoji: "💡", label: "Top idea to build", value: dossier.ideas[0].title });

// Anything that genuinely wants a decision this week, surfaced above the narrative.
const attention = [];
if (code.high) attention.push({ title: `${code.high} high-severity code issue${code.high > 1 ? "s" : ""}`, note: `${code.top_categories.join(", ") || "see CTO report"} · ${code.repos.join(", ")}` });
for (const r of br.regressions.slice(0, 3)) attention.push({ title: "Brand regression", note: r });
if (br.broken_links) attention.push({ title: `${br.broken_links} broken link${br.broken_links > 1 ? "s" : ""} across your sites`, note: br.weakest ? `Weakest property: ${br.weakest}` : "" });
if (linkedin.awaiting) attention.push({ title: `${linkedin.awaiting} LinkedIn draft${linkedin.awaiting > 1 ? "s" : ""} awaiting approval`, note: "Approve or edit from Telegram / the dashboard." });
if (jb.best.length) attention.push({ title: "Best-fit role this week", note: jb.best[0] });
if (dossier.outreach.new) attention.push({ title: `${dossier.outreach.new} new opportunit${dossier.outreach.new > 1 ? "ies" : "y"}`, note: dossier.outreach.titles.join(" · ") });

const blocks = [{ type: "tiles", items: tiles }];
if (attention.length) blocks.push({ type: "listSection", heading: "NEEDS A DECISION", ramp: "coral", items: attention.slice(0, 6) });
blocks.push({ type: "divider" }, { type: "text", html: body });

const html = renderEmail({
  title: "🧭 Weekly Founder Review",
  kicker: "STATE OF YOU",
  accent: "#2C3E50",
  blocks,
  footer: "Orchestrated from journal · habits · finance · reading · ideas · jobs · skills · outreach · build · launches · LinkedIn · code reviews · brand",
});
await notifyEmail("🧭 Your Weekly Founder Review", html);
console.log(report);
