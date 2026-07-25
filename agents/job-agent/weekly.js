// agents/job-agent/weekly.js — the Monday review of the job search.
//
// Two jobs in one email:
//   1. What actually happened last week — found, applied, interviewing, dismissed.
//   2. What the agent learned from your dismissals, as concrete proposals you can approve.
//
// The second half is the point. The daily run can only ever apply the targeting it was given;
// this is the loop that makes the targeting better, and it runs on the one signal no amount of
// clever filtering can produce on its own — you saying "no, not that one".
//
// PROPOSALS ARE NEVER APPLIED AUTOMATICALLY (see feedback.js). You read them and decide.
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { analyzeDismissals, summarizeFeedback } from "./feedback.js";
import { staleApplications, summarizeFollowups } from "./followup.js";
import { notifyEmail } from "../../lib/notify.js";
import { renderEmail } from "../../lib/email-template.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));
const DAYS = Number(process.env.WEEKLY_WINDOW_DAYS || 7);
const since = new Date(Date.now() - DAYS * 864e5).toISOString();
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
const titleCase = (s) => String(s || "").replace(/_/g, " ");

// Everything recent, plus every dismissal ever — proposals get stronger with more evidence, and a
// company you rejected a month ago is still a company you don't want.
const { data: recent = [] } = await db.from("jobs")
  .select("id,title,company,fit,status,dismiss_reason,geo_class,geo_reason,source,url,apply_state,created_at,applied_at")
  .gte("created_at", since);
const { data: allDismissed = [] } = await db.from("jobs")
  .select("title,company,dismiss_reason,geo_class,geo_reason,fit,url,source")
  .not("dismiss_reason", "is", null);
const { data: pipeline = [] } = await db.from("jobs")
  .select("id,title,company,status,apply_state,applied_at,updated_at,created_at,url,apply_url")
  .in("status", ["shortlisted", "applied", "screening", "interviewing", "offer"]);

// Kept roles give the analyzer its counter-evidence: a word that appears in roles you KEPT is
// describing your search, not the noise in it.
const { data: kept = [] } = await db.from("jobs").select("title").is("dismiss_reason", null).limit(1000);

const analysis = analyzeDismissals([...allDismissed, ...kept]);
const found = recent.length;
const applied = recent.filter((r) => r.status === "applied" || r.applied_at).length;
const dismissedThisWeek = recent.filter((r) => r.dismiss_reason).length;

if (!found && !analysis.total && !pipeline.length) {
  console.log("Nothing to report — no roles, no dismissals, no pipeline.");
  process.exit(0);
}

const blocks = [
  { type: "tiles", items: [
    { ramp: "green", label: "Found", value: String(found) },
    { ramp: found ? "green" : "gray", label: "Applied", value: String(applied) },
    { ramp: "gray", label: "Dismissed", value: String(dismissedThisWeek) },
    { ramp: pipeline.length ? "green" : "gray", label: "In play", value: String(pipeline.length) },
  ] },
];

// --- Live pipeline ------------------------------------------------------------------------------
if (pipeline.length) {
  const byStatus = {};
  for (const r of pipeline) (byStatus[r.status] ||= []).push(r);
  blocks.push({
    type: "listSection", ramp: "green", heading: "IN PLAY",
    items: Object.entries(byStatus).map(([status, rows]) => ({
      title: `${titleCase(status)} — ${rows.length}`,
      note: rows.slice(0, 6).map((r) => `${r.title} @ ${r.company}`).join(" · "),
    })),
  });
}

// --- Applications that have gone quiet -----------------------------------------------------------
// The silent failure mode: an application sits for five weeks and neither becomes an interview nor
// gets marked dead, so the pipeline count flatters itself.
const stale = staleApplications(pipeline);
if (stale.length) {
  blocks.push({ type: "divider" });
  blocks.push({
    type: "listSection", ramp: "amber", heading: "GONE QUIET — CHASE OR CLOSE",
    items: stale.slice(0, 8).map((s) => ({
      title: `${s.days}d silent · ${s.title} @ ${s.company}`,
      note: `${titleCase(s.status)} · ${s.action}`,
      link: s.url || undefined,
    })),
  });
  if (stale.length > 8) blocks.push({ type: "text", html: `<i>…and ${stale.length - 8} more.</i>` });
}

// --- What the agent learned ---------------------------------------------------------------------
if (analysis.total) {
  blocks.push({ type: "divider" });
  blocks.push({ type: "stat", text: summarizeFeedback(analysis) });

  if (analysis.proposals.length) {
    blocks.push({
      type: "listSection", ramp: "amber", heading: "PROPOSED CHANGES — YOUR CALL",
      items: analysis.proposals.slice(0, 8).map((p) => ({
        title: `${p.confidence.toUpperCase()} · ${p.change}`,
        note: p.evidence,
        link: p.url || undefined,
      })),
    });
    blocks.push({ type: "text", html: `<span style="opacity:.7">Nothing above has been applied. Edit <code>agents/job-agent/config.js</code> to accept a proposal.</span>` });
  } else {
    blocks.push({ type: "text", html: "No filter changes worth proposing — dismissals so far look like preference, not bad targeting." });
  }

  const reasons = Object.entries(analysis.byReason).sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${titleCase(r)} ${n}`).join(" · ");
  blocks.push({ type: "text", html: `<b>Why roles were dismissed (all time):</b> ${esc(reasons)}` });
}

// --- Roles still waiting on you -------------------------------------------------------------------
const waiting = recent.filter((r) => r.status === "new" && !r.dismiss_reason).sort((a, b) => (b.fit || 0) - (a.fit || 0));
if (waiting.length) {
  blocks.push({ type: "divider" });
  blocks.push({
    type: "listSection", ramp: "gray", heading: "STILL UNTRIAGED",
    items: waiting.slice(0, 6).map((r) => ({
      title: `${r.fit ?? "?"}% · ${r.title} @ ${r.company}`,
      note: `via ${r.source || "?"}`,
      link: r.url || undefined,
    })),
  });
  if (waiting.length > 6) blocks.push({ type: "text", html: `<i>…and ${waiting.length - 6} more on the dashboard.</i>` });
}

await notifyEmail(
  `📊 Job search week: ${found} found · ${applied} applied${stale.length ? ` · ${stale.length} gone quiet` : ""} · ${analysis.proposals.length} proposal(s)`,
  renderEmail({
    title: "Weekly Job Review",
    subtitle: `Last ${DAYS} days · ${pipeline.length} role(s) in play`,
    kicker: "JOB AGENT",
    accent: "#0F6E56",
    blocks,
    footer: "Job Agent · proposals are suggestions only — nothing was changed for you",
  }),
);
console.log(`Weekly review sent: ${found} found, ${applied} applied, ${analysis.proposals.length} proposals.`);
if (stale.length) console.log(summarizeFollowups(stale));
