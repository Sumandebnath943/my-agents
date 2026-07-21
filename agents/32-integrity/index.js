// agents/32-integrity/index.js — the silent-success detector ("did any agent lie to me today?").
//
// Every bug in the 2026-07-21 session reported success while doing nothing (PROJECT_BIBLE S13.9).
// The lesson — "best-effort must never mean silent" — was applied by hand to /reindex, seed-voice
// and MAS /index, but nothing WATCHED for the next instance. This does.
//
// It answers two questions, cheaply and with no LLM at all:
//   1. Has a table that should be receiving rows gone quiet? (an agent running green but writing nothing)
//   2. Are there rows stored WITHOUT the embedding that makes them retrievable? (the ECHO/MAS bug)
//
// Quiet by default: it only messages you when something is actually wrong. `DIGEST=1` forces an
// all-clear so you can confirm the probe itself is alive.
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { notifyTelegram, tgEscape } from "../../lib/notify.js";
import { FRESHNESS, VECTOR_STORES, freshnessFinding, vectorFinding, buildReport } from "./probes.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));
const DIGEST = process.env.DIGEST === "1";
const now = new Date();

// Newest row's timestamp for one table. Supabase RESOLVES with { error } instead of rejecting,
// so the error must be read off the result — the exact trap that hid the S13 outage.
async function latestRow(table, column) {
  try {
    const { data, error } = await db.from(table).select(column).order(column, { ascending: false }).limit(1);
    if (error) return { error: error.message || String(error) };
    return { latest: data?.[0]?.[column] ?? null };
  } catch (e) { return { error: e.message || String(e) }; }
}

// Count rows missing their vector. Done in JS rather than a jsonb-path filter so it works the same
// for a plain column (agent_memories.embedding) and a nested one (mas_memory.metadata.vec).
async function vectorSample(table, field) {
  const col = field.split(".")[0];
  try {
    const { data, error } = await db.from(table).select(`id,${col}`).limit(1000);
    if (error) return { error: error.message || String(error) };
    const rows = data || [];
    const missing = rows.filter((r) => {
      const v = field.includes(".") ? r?.[col]?.[field.split(".")[1]] : r?.[col];
      return !Array.isArray(v) || v.length === 0;
    }).length;
    return { total: rows.length, missing };
  } catch (e) { return { error: e.message || String(e) }; }
}

const findings = [];
for (const spec of FRESHNESS) findings.push(freshnessFinding(spec, await latestRow(spec.table, spec.column), now));
for (const spec of VECTOR_STORES) findings.push(vectorFinding(spec, await vectorSample(spec.table, spec.field)));

const report = buildReport(findings, { digest: DIGEST });

for (const f of report.actionable) console.error(`[${f.level}] ${f.title} — ${f.detail}`);
for (const f of report.unknowns) console.log(`[unknown] ${f.title} — ${f.detail}`);
if (report.healthy) console.log("integrity: all probes healthy.");

if (!report.shouldNotify) process.exit(0);

const line = (f) => `${f.level === "alert" ? "🔴" : "🟠"} <b>${tgEscape(f.title)}</b>\n${tgEscape(f.detail)}`;
const body = report.actionable.length
  ? report.actionable.map(line).join("\n\n")
  : "🟢 Every probe is healthy — tables are being written to, and no unretrievable rows found.";
const unknownNote = DIGEST && report.unknowns.length
  ? `\n\n<i>Couldn't check: ${tgEscape(report.unknowns.map((u) => u.table).join(", "))}</i>`
  : "";

await notifyTelegram(
  `🕵️ <b>Integrity probe</b>\n<i>silent-failure watch · ${report.actionable.length} finding(s)</i>\n\n${body}${unknownNote}`,
  { html: true }
);
console.log(`integrity: notified — ${report.alerts.length} alert(s), ${report.warns.length} warning(s).`);
