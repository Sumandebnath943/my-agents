// agents/32-integrity/probes.js
// The DECISION half of the integrity probe, kept pure so it can be unit-eval'd offline
// (no DB, no network) — same pattern as agents/inbox-router/route.js.
//
// Background (PROJECT_BIBLE S13.9): every bug in the 2026-07-21 session had the same shape —
// something reported success while doing nothing. ECHO "learned 8 chunks" with no vectors, MAS
// "indexed N items" that could never be recalled, seed-voice exited green having saved zero, and a
// retired embedding model 404'd invisibly for weeks because every best-effort wrapper swallowed it.
// The lesson was written down but never automated. These probes automate it.
//
// Design rule: a FALSE ALARM is worse than no alarm, because it trains you to ignore the channel.
// So an unreadable table is reported as "unknown" (quiet, digest-only), never as a failure.

/** Freshness expectations. A table that stops receiving rows is the cheapest silent-failure signal. */
export const FRESHNESS = [
  // NOTE: llm_metrics and ops_events timestamp their rows with `ts`, not `created_at` — getting
  // this wrong made the probe's first live run report "table is missing" for a table that was
  // perfectly healthy. Always confirm the column against the writer before adding a spec.
  { table: "llm_metrics",          column: "ts",         maxAgeDays: 3,  why: "every LLM call logs here — silence means attribution/metrics broke, or no agent has run" },
  { table: "agent_outputs",        column: "created_at", maxAgeDays: 3,  why: "every Telegram/email is mirrored here — silence means notify logging broke" },
  { table: "linkedin_posts",       column: "created_at", maxAgeDays: 14, why: "the LinkedIn autopilot drafts here" },
  { table: "linkedin_engagement",  column: "sampled_at", maxAgeDays: 14, why: "the Sunday recap samples engagement here", setupSql: "sql/linkedin_engagement.sql" },
  { table: "finance",              column: "created_at", maxAgeDays: 21, why: "SMS ledger ingest — silence may mean the phone macro stopped posting" },
  { table: "agent_memories",       column: "updated_at", maxAgeDays: 45, why: "the learned-voice / memory layer writes here", setupSql: "sql/agent_memories.sql" },
];

/** Stores whose rows are only useful WITH an embedding. A vector-less row is invisible forever. */
export const VECTOR_STORES = [
  { table: "agent_memories", field: "embedding", why: "lib/memory.js recall is cosine-only — a row with no embedding can never be recalled", fix: "delete from agent_memories where embedding is null; then re-run the seed (npm run linkedin:seed-voice)" },
  { table: "mas_memory",     field: "metadata.vec", why: "MAS recall is cosine-only over metadata.vec — these rows are unrecallable", fix: "delete from mas_memory where metadata->'vec' is null; then re-run /index on the MAS bot" },
];

const days = (ms) => ms / 86400000;

/** Whole days since an ISO timestamp, or null when unparseable. */
export function ageInDays(iso, now = new Date()) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor(days(now.getTime() - t)));
}

/**
 * Turn one freshness reading into a finding (or null when healthy).
 * @param {{table,column,maxAgeDays,why,setupSql?}} spec
 * @param {{latest?:string|null, error?:string|null, emptySince?:string|null}} reading
 *        `emptySince` = when this table was FIRST observed empty (kv `integrity:empty_since`).
 */
export function freshnessFinding(spec, reading, now = new Date()) {
  const { latest = null, error = null, emptySince = null } = reading || {};

  if (error) {
    // A MISSING COLUMN is a bug in this probe's own config, not evidence the fleet is broken.
    // PostgREST words it "column x.y does not exist", which also matches the table test below —
    // so it must be checked FIRST or a mis-specced column masquerades as a missing table.
    if (/column\b/i.test(error)) {
      return {
        level: "warn", table: spec.table,
        title: `Integrity probe is misconfigured for \`${spec.table}\``,
        detail: `Column \`${spec.column}\` doesn't exist, so this table isn't actually being checked. ${error.slice(0, 100)}`,
      };
    }
    // A genuinely missing TABLE is actionable — usually a setup SQL that was never run.
    if (/does not exist|could not find the table|schema cache/i.test(error)) {
      return {
        level: spec.setupSql ? "alert" : "warn",
        table: spec.table,
        title: `Table \`${spec.table}\` is missing`,
        detail: spec.setupSql ? `Run ${spec.setupSql} in the Supabase SQL editor — until then, ${spec.why}.` : spec.why,
      };
    }
    // Anything else (permissions, transient) is NOT evidence of failure — stay quiet.
    return { level: "unknown", table: spec.table, title: `Couldn't check \`${spec.table}\``, detail: error.slice(0, 160) };
  }

  if (!latest) {
    // An empty table is only evidence of failure once it has STAYED empty longer than the
    // producing agent's cadence. A table created 5 minutes ago whose writer runs on Sunday is
    // simply waiting — warning about it is a false alarm, and false alarms get the channel muted.
    if (!emptySince) {
      return { level: "unknown", table: spec.table, first_empty: true, title: `\`${spec.table}\` is empty (first seen)`, detail: `Waiting up to ${spec.maxAgeDays}d for its first row before flagging this.` };
    }
    const emptyFor = ageInDays(emptySince, now);
    if (emptyFor === null || emptyFor <= spec.maxAgeDays) {
      return { level: "unknown", table: spec.table, title: `\`${spec.table}\` still empty`, detail: `Empty for ${emptyFor ?? "?"}d of an allowed ${spec.maxAgeDays}d.` };
    }
    return { level: "warn", table: spec.table, title: `\`${spec.table}\` has been empty for ${emptyFor} days`, detail: `Nothing has ever been written. ${spec.why}.` };
  }

  const age = ageInDays(latest, now);
  if (age === null) return { level: "unknown", table: spec.table, title: `\`${spec.table}\` has an unreadable timestamp`, detail: String(latest).slice(0, 60) };
  if (age > spec.maxAgeDays) {
    return {
      level: "alert",
      table: spec.table,
      title: `\`${spec.table}\` hasn't been written to in ${age} days`,
      detail: `Expected at least every ${spec.maxAgeDays}d. ${spec.why}.`,
    };
  }
  return null; // healthy
}

/**
 * Turn a vector-store sample into a finding (or null when healthy).
 * @param {{table,field,why,fix}} spec
 * @param {{total?:number, missing?:number, error?:string|null}} reading
 */
export function vectorFinding(spec, reading) {
  const { total = 0, missing = 0, error = null } = reading || {};
  if (error) {
    if (/does not exist|could not find the table|schema cache/i.test(error)) return null; // table simply not in use
    return { level: "unknown", table: spec.table, title: `Couldn't check \`${spec.table}\``, detail: error.slice(0, 160) };
  }
  if (!total || !missing) return null;
  const pct = Math.round((missing / total) * 100);
  return {
    level: missing === total ? "alert" : "warn",
    table: spec.table,
    title: `${missing} of ${total} rows in \`${spec.table}\` have no ${spec.field} (${pct}%)`,
    detail: `${spec.why}. Fix: ${spec.fix}`,
  };
}

/** Collapse findings into the report the agent sends. Alerts first, "unknown" only in a digest. */
export function buildReport(findings, { digest = false } = {}) {
  const all = (findings || []).filter(Boolean);
  const alerts = all.filter((f) => f.level === "alert");
  const warns = all.filter((f) => f.level === "warn");
  const unknowns = all.filter((f) => f.level === "unknown");
  const actionable = [...alerts, ...warns];
  return {
    alerts, warns, unknowns, actionable,
    healthy: actionable.length === 0,
    shouldNotify: actionable.length > 0 || digest,
  };
}
