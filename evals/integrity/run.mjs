// evals/integrity/run.mjs
// Guards the silent-success detector's decision logic (agents/32-integrity/probes.js).
// Pure + offline.
//
// The false-alarm cases are the important ones. A probe that cries wolf gets muted, and a muted
// probe is worse than no probe — so an unreadable table must degrade to "unknown", never "alert".
import "../_env.mjs";
import { runCases, isMain } from "../_lib.mjs";
import { FRESHNESS, VECTOR_STORES, ageInDays, freshnessFinding, vectorFinding, buildReport } from "../../agents/32-integrity/probes.js";

const NOW = new Date("2026-07-21T12:00:00Z");
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();
const spec = { table: "llm_metrics", column: "created_at", maxAgeDays: 3, why: "reason" };
const setupSpec = { table: "linkedin_engagement", column: "sampled_at", maxAgeDays: 14, why: "reason", setupSql: "sql/linkedin_engagement.sql" };

export function run() {
  const fresh = runCases("integrity · freshness decisions", [
    { id: "recent row -> healthy (null)", check: () => freshnessFinding(spec, { latest: daysAgo(1) }, NOW) === null },
    { id: "exactly at limit -> healthy", check: () => freshnessFinding(spec, { latest: daysAgo(3) }, NOW) === null },
    { id: "past limit -> alert", check: () => freshnessFinding(spec, { latest: daysAgo(9) }, NOW)?.level === "alert" },
    { id: "alert names the age", check: () => freshnessFinding(spec, { latest: daysAgo(9) }, NOW).title.includes("9 days") },
    { id: "empty table -> warn not alert", check: () => freshnessFinding(spec, { latest: null }, NOW)?.level === "warn" },
    { id: "missing table w/ setup sql -> alert", check: () => freshnessFinding(setupSpec, { error: 'relation "public.linkedin_engagement" does not exist' }, NOW)?.level === "alert" },
    { id: "missing-table alert names the sql file", check: () => freshnessFinding(setupSpec, { error: "does not exist" }, NOW).detail.includes("sql/linkedin_engagement.sql") },
    { id: "PostgREST schema-cache wording detected", check: () => freshnessFinding(setupSpec, { error: "Could not find the table 'public.x' in the schema cache" }, NOW)?.level === "alert" },
    { id: "missing table w/o setup sql -> warn", check: () => freshnessFinding(spec, { error: "does not exist" }, NOW)?.level === "warn" },
    // --- false-alarm guards ---
    { id: "permission error -> unknown NOT alert", check: () => freshnessFinding(spec, { error: "permission denied for table llm_metrics" }, NOW)?.level === "unknown" },
    { id: "network error -> unknown", check: () => freshnessFinding(spec, { error: "fetch failed" }, NOW)?.level === "unknown" },
    { id: "unparseable timestamp -> unknown", check: () => freshnessFinding(spec, { latest: "yesterday-ish" }, NOW)?.level === "unknown" },
    { id: "future timestamp -> healthy not alert", check: () => freshnessFinding(spec, { latest: daysAgo(-5) }, NOW) === null },
    { id: "null reading -> warn (treated as empty)", check: () => freshnessFinding(spec, null, NOW)?.level === "warn" },
  ], (c) => ({ ok: c.check() }));

  const vspec = VECTOR_STORES[0];
  const vec = runCases("integrity · vector-store decisions", [
    { id: "all embedded -> healthy", check: () => vectorFinding(vspec, { total: 12, missing: 0 }) === null },
    { id: "empty store -> healthy", check: () => vectorFinding(vspec, { total: 0, missing: 0 }) === null },
    { id: "some missing -> warn", check: () => vectorFinding(vspec, { total: 12, missing: 3 })?.level === "warn" },
    { id: "ALL missing -> alert", check: () => vectorFinding(vspec, { total: 8, missing: 8 })?.level === "alert" },
    { id: "reports the percentage", check: () => vectorFinding(vspec, { total: 10, missing: 3 }).title.includes("(30%)") },
    { id: "includes the repair sql", check: () => vectorFinding(vspec, { total: 8, missing: 8 }).detail.includes("delete from agent_memories") },
    { id: "absent table -> silent (not in use)", check: () => vectorFinding(vspec, { error: "does not exist" }) === null },
    { id: "other error -> unknown", check: () => vectorFinding(vspec, { error: "permission denied" })?.level === "unknown" },
    { id: "null reading -> healthy", check: () => vectorFinding(vspec, null) === null },
  ], (c) => ({ ok: c.check() }));

  const A = { level: "alert", title: "a", detail: "d" };
  const W = { level: "warn", title: "w", detail: "d" };
  const U = { level: "unknown", title: "u", detail: "d" };
  const rep = runCases("integrity · report assembly", [
    { id: "no findings -> healthy, silent", check: () => { const r = buildReport([]); return r.healthy && !r.shouldNotify; } },
    { id: "nulls filtered out", check: () => buildReport([null, null]).healthy === true },
    { id: "unknowns alone stay silent", check: () => { const r = buildReport([U]); return r.healthy && !r.shouldNotify; } },
    { id: "an alert breaks silence", check: () => buildReport([A]).shouldNotify === true },
    { id: "a warning breaks silence", check: () => buildReport([W]).shouldNotify === true },
    { id: "alerts sort before warnings", check: () => buildReport([W, A]).actionable[0].level === "alert" },
    { id: "digest notifies even when healthy", check: () => { const r = buildReport([], { digest: true }); return r.healthy && r.shouldNotify; } },
    { id: "counts are separated", check: () => { const r = buildReport([A, W, U]); return r.alerts.length === 1 && r.warns.length === 1 && r.unknowns.length === 1; } },
    { id: "undefined input is safe", check: () => buildReport(undefined).healthy === true },
  ], (c) => ({ ok: c.check() }));

  const cfg = runCases("integrity · config sanity", [
    { id: "ageInDays whole days", check: () => ageInDays(daysAgo(5), NOW) === 5 },
    { id: "ageInDays invalid -> null", check: () => ageInDays("nope", NOW) === null },
    { id: "every freshness spec is complete", check: () => FRESHNESS.every((s) => s.table && s.column && Number.isFinite(s.maxAgeDays) && s.why) },
    { id: "no duplicate freshness tables", check: () => new Set(FRESHNESS.map((s) => s.table)).size === FRESHNESS.length },
    { id: "every vector store is complete", check: () => VECTOR_STORES.every((s) => s.table && s.field && s.why && s.fix) },
    { id: "watches the new engagement table", check: () => FRESHNESS.some((s) => s.table === "linkedin_engagement") },
    { id: "watches both vector stores", check: () => VECTOR_STORES.map((s) => s.table).join() === "agent_memories,mas_memory" },
  ], (c) => ({ ok: c.check() }));

  return [fresh, vec, rep, cfg];
}

if (isMain(import.meta.url)) {
  const results = run();
  if (results.some((r) => r.fail)) process.exit(1);
}
